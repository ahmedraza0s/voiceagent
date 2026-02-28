import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import path from 'path';
import config from './config';
import logger from './utils/logger';
import { FreeSwitchService } from './services/freeswitch/FreeSwitchService';
import { SIPService } from './services/sip';
import { ConversationPipeline } from './services/conversation/pipeline';
import { DeepgramSTTService } from './services/stt/deepgram';
import { SarvamTTSService } from './services/tts/sarvam';
import { GroqLLMService } from './services/llm/groq';
import { agentService } from './services/agents/AgentService';
import { sipSettingsService, SipSettings } from './services/sip/SipSettingsService';
import { authService } from './services/auth/AuthService';

/**
 * AI Voice Agent Backend — FreeSWITCH Edition
 * All call handling (inbound + outbound) is done via FreeSWITCH (drachtio-srf ESL).
 * Audio pipeline: FreeSWITCH RTP ↔ Deepgram STT → Groq LLM → Sarvam TTS ↔ FreeSWITCH RTP
 */
class VoiceAgentApp {
    private freeSwitchService: FreeSwitchService;
    private sipService: SIPService;
    private activePipelines: Map<string, ConversationPipeline> = new Map();

    constructor() {
        // Initialize FreeSWITCH ESL service
        this.freeSwitchService = new FreeSwitchService();
        this.sipService = new SIPService(this.freeSwitchService);

        // Wire outbound call connected event
        this.freeSwitchService.on('callConnected', async (data) => {
            logger.info('📞 Outbound call connected event received', { callId: data.callId });

            const pipeline = this.activePipelines.get(data.callId);
            if (!pipeline) {
                logger.warn('No active pipeline found for call', { callId: data.callId });
                return;
            }

            // At this point uac is available, we can parse remote SDP if not already done
            if (data.uac?.remote?.sdp) {
                const { address, port } = FreeSwitchService.parseSdp(data.uac.remote.sdp);
                logger.info('Setting remote endpoint from UAC SDP', { address, port, callId: data.callId });
                (pipeline as any).bridge.setRemoteEndpoint(address, port);
            } else {
                logger.warn('No UAC or SDP available in callConnected data', { callId: data.callId });
            }

            logger.info('Triggering greeting for call', { callId: data.callId });
            await pipeline.sayHello().catch(err =>
                logger.error('Error saying hello', { error: err.message, callId: data.callId })
            );
        });

        // Wire call ended event
        this.freeSwitchService.on('callEnded', async (data) => {
            const pipeline = this.activePipelines.get(data.callId);
            if (pipeline) {
                await pipeline.stop();
                this.activePipelines.delete(data.callId);
            }
        });

        // Wire inbound calls from FreeSWITCH Service
        this.freeSwitchService.on('inboundCall', (data) => {
            this.handleInboundCall(data.callId, data.req, data.res).catch(err => {
                logger.error('Error handling inbound call', { error: err.message, callId: data.callId });
            });
        });

        // Initialize SIP registrations
        this.initializeSipRegistrations();
    }

    private async initializeSipRegistrations() {
        this.freeSwitchService.on('connected', async () => {
            const settings = await sipSettingsService.listSettings();
            logger.info(`🔄 Initializing ${settings.length} SIP registrations`);
            for (const s of settings) {
                await this.freeSwitchService.registerSettings(s);
            }
        });
    }

    async makeOutboundCall(phoneNumber: string, sipId?: string, agentId?: string, systemPrompt?: string, voiceId?: string): Promise<string> {
        try {
            logger.info('Making outbound call', { phoneNumber, sipId });

            const callId = `call-${Date.now()}`;

            // Start conversation pipeline first to get local RTP port
            const pipeline = new ConversationPipeline();

            // Look up SIP settings if provided
            const sipSettings = sipId ? await sipSettingsService.getSettings(sipId) : undefined;

            // Look up agent config
            // Priority: agentId -> sipSettings.inboundAgentId (mapping)
            const agent = agentId ? await agentService.getAgentInternal(agentId) :
                (sipSettings?.inboundAgentId ? await agentService.getAgentInternal(sipSettings.inboundAgentId) : undefined);

            if (agent) {
                logger.info('Using agent configuration', { agentName: agent.name });
                // All configuration is now handled via pipeline.start()
            } else if (systemPrompt || voiceId) {
                // If no agent, we might still have manual overrides
                // These will be passed to start() below
            }

            // Register the pipeline IMMEDIATELY to avoid race conditions with events
            this.activePipelines.set(callId, pipeline);
            this.setupPipelineEvents(pipeline, callId);

            // Use SIP_PUBLIC_IP if available (especially for Docker networking), otherwise local
            const localIp = process.env.SIP_PUBLIC_IP || process.env.LOCAL_IP || '127.0.0.1';

            // Start pipeline with agent config (or manual overrides)
            // This handles bridge start, STT connect, and setting LLM/TTS/Plans
            await pipeline.start(callId, undefined, undefined, agent || { systemPrompt, voiceId } as any);

            const localPort = pipeline.localRtpPort;
            const localSdp = FreeSwitchService.generateSdp(localIp, localPort);

            logger.info('Starting outbound call via SIP Service', { callId, localPort, localIp });

            // Initiate call via FreeSWITCH with our SDP and pre-generated callId and selective settings
            await this.sipService.makeOutboundCall(phoneNumber, localSdp, callId, sipSettings);

            logger.info('✅ Outbound call initiated', { callId, phoneNumber, localPort });
            return callId;
        } catch (error) {
            logger.error('Failed to make outbound call', { error, phoneNumber });
            throw error;
        }
    }

    async handleInboundCall(callId: string, req: any, res: any): Promise<void> {
        try {
            logger.info('Handling inbound call from FreeSWITCH', { callId });

            const pipeline = new ConversationPipeline();

            // Identify which SIP account this call came for using direct DB lookup
            // findByToHeader() queries DB with LIKE filter — no full table scan
            const toHeader = req.get('To') || '';
            logger.info('Identifying SIP account for inbound call', { toHeader });

            const matchedSip = await sipSettingsService.findByToHeader(toHeader);

            if (!matchedSip) {
                logger.warn('No SIP account matched for inbound call. Defaulting to first agent if available.', { toHeader });
            }

            let agentId = matchedSip?.inboundAgentId;
            let agent = agentId ? await agentService.getAgentInternal(agentId) : undefined;

            if (agent) {
                logger.info('Assigning agent for inbound call', {
                    agentName: agent.name,
                    sipUsername: matchedSip?.username || 'unknown'
                });
            }

            this.activePipelines.set(callId, pipeline);
            this.setupPipelineEvents(pipeline, callId);

            // Parse remote SDP to know where to send audio back
            let remoteIp: string | undefined;
            let remotePort: number | undefined;
            if (req.body) {
                const remote = FreeSwitchService.parseSdp(req.body);
                remoteIp = remote.address;
                remotePort = remote.port;
            }

            // Start pipeline with agent config
            // This handles bridge start, STT connect, and setting LLM/TTS/Plans
            await pipeline.start(callId, remoteIp, remotePort, agent);

            const localPort = pipeline.localRtpPort;
            // Use SIP_PUBLIC_IP if available (especially for Docker networking), otherwise local
            const localIp = process.env.SIP_PUBLIC_IP || process.env.LOCAL_IP || '127.0.0.1';
            const localSdp = FreeSwitchService.generateSdp(localIp, localPort);

            // Answer via FreeSWITCH
            await this.freeSwitchService.answerInboundCall(req, res, localSdp);

            logger.info('📞 Inbound call answered, triggering greeting', { callId });
            await pipeline.sayHello();

        } catch (error: any) {
            logger.error('Failed to handle inbound call', { error: error.message, callId });
            if (res) res.send(500);
            throw error;
        }
    }

    private setupPipelineEvents(pipeline: ConversationPipeline, callId: string): void {
        pipeline.on('ready', () => logger.info('Pipeline ready', { callId }));
        pipeline.on('transcriptReceived', (transcript: string) => {
            logger.info('User said:', { transcript, callId });
        });
        pipeline.on('bargeIn', (interim: string) => {
            logger.info('User interrupted', { interim, callId });
        });
        pipeline.on('responseComplete', () =>
            logger.info('AI response complete', { callId }));
        pipeline.on('stopped', async () => {
            logger.info('Pipeline stopped', { callId });
            this.activePipelines.delete(callId);
            await this.sipService.deleteRoom(callId);
        });
        pipeline.on('error', (error: Error) =>
            logger.error('Pipeline error', { error, callId }));
    }

    async endCall(callId: string): Promise<void> {
        const pipeline = this.activePipelines.get(callId);
        if (pipeline) {
            await pipeline.stop();
            this.activePipelines.delete(callId);
        }
        await this.sipService.endCall(callId);
    }

    async registerSipAccount(settings: SipSettings) {
        await this.freeSwitchService.registerSettings(settings);
    }

    async unregisterSipAccount(id: string) {
        await this.freeSwitchService.unregisterSettings(id);
    }

    stop(): void {
        this.freeSwitchService.stop();
        this.freeSwitchService.removeAllListeners();
        for (const pipeline of this.activePipelines.values()) {
            pipeline.stop();
        }
        this.activePipelines.clear();
    }

    getActiveCalls(): string[] {
        return Array.from(this.activePipelines.keys());
    }
}

const { app } = expressWs(express());
const voiceApp = new VoiceAgentApp();

// Track active calls per user to prevent duplicates — Map<userId, activeCall>
const activeCallsByUser = new Map<number, { callId: string; phoneNumber: string }>();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// --- Authentication Middleware ---
const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

    try {
        const decoded = authService.verifyToken(token);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }
};

// --- Authentication API ---
app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    try {
        const user = await authService.register(email, password);
        return res.json({ success: true, user: { id: user.id, email: user.email } });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Registration failed' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    try {
        const { user, token } = await authService.login(email, password);
        return res.json({ success: true, token, user: { id: user.id, email: user.email } });
    } catch (error: any) {
        return res.status(401).json({ error: error.message || 'Login failed' });
    }
});

app.post('/api/auth/logout', (_req, res) => {
    // Client-side should discard the token
    return res.json({ success: true, message: 'Logged out successfully' });
});

// Protect relevant API routes with authenticateToken
app.use('/api/agents', authenticateToken);
app.use('/api/sip-settings', authenticateToken);
app.use('/api/call', authenticateToken);
app.use('/api/end-call', authenticateToken);
app.use('/api/calls', authenticateToken);

// --- Agent Management API ---

// List all agents
app.get('/api/agents', async (req: any, res) => {
    res.json(await agentService.listAgents(req.user.id));
});

// Get single agent
app.get('/api/agents/:id', async (req: any, res) => {
    const agent = await agentService.getAgent(req.params.id, req.user.id);
    return agent ? res.json(agent) : res.status(404).json({ error: 'Agent not found' });
});

// Create/Update agent
app.post('/api/agents', async (req: any, res) => {
    const { id, name, systemPrompt, voiceId, llmProvider, llmModel, maxTokens, temperature, ttsProvider, ttsModel, startSpeakingPlan, stopSpeakingPlan } = req.body;
    if (!name || !systemPrompt || !voiceId) {
        return res.status(400).json({ error: 'Name, systemPrompt, and voiceId are required' });
    }

    const agentData = {
        name, systemPrompt, voiceId,
        llmProvider, llmModel, maxTokens: Number(maxTokens),
        temperature: Number(temperature), ttsProvider, ttsModel,
        startSpeakingPlan, stopSpeakingPlan
    };

    if (id) {
        const updated = await agentService.updateAgent(id, req.user.id, agentData);
        return updated ? res.json(updated) : res.status(404).json({ error: 'Agent not found' });
    } else {
        const created = await agentService.createAgent(req.user.id, name, systemPrompt, voiceId, agentData);
        return res.json(created);
    }
});

// Delete agent
app.delete('/api/agents/:id', async (req: any, res) => {
    const success = await agentService.deleteAgent(req.params.id, req.user.id);
    return success ? res.json({ success: true }) : res.status(404).json({ error: 'Agent not found' });
});

// --- SIP Settings Management API ---

// List all SIP settings
app.get('/api/sip-settings', async (req: any, res) => {
    res.json(await sipSettingsService.listSettings(req.user.id));
});

// Create/Update SIP settings
app.post('/api/sip-settings', async (req: any, res) => {
    const { id, name, username, password, domain, port, callerId, proxy, inboundAgentId } = req.body;
    if (!name || !username || !domain || !port) {
        return res.status(400).json({ error: 'Name, username, domain, and port are required' });
    }

    if (id) {
        const updated = await sipSettingsService.updateSettings(id, req.user.id, {
            name, username, password, domain, port, callerId, proxy, inboundAgentId
        });
        if (updated) {
            // Re-register if settings updated
            await voiceApp.registerSipAccount(updated);
            return res.json(updated);
        }
        return res.status(404).json({ error: 'Settings not found' });
    } else {
        const created = await sipSettingsService.createSettings(req.user.id, {
            name, username, password, domain, port, callerId, proxy, inboundAgentId
        });
        // Register new account
        await voiceApp.registerSipAccount(created);
        return res.json(created);
    }
});

// Delete SIP settings
app.delete('/api/sip-settings/:id', async (req: any, res) => {
    const id = req.params.id;
    await voiceApp.unregisterSipAccount(id);
    const success = await sipSettingsService.deleteSettings(id, req.user.id);
    return success ? res.json({ success: true }) : res.status(404).json({ error: 'Settings not found' });
});

// --- Call Control API ---
app.post('/api/call', async (req: any, res) => {
    const { phoneNumber, sipId, agentId, systemPrompt, voiceId } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    const userId: number = req.user.id;
    const existingCall = activeCallsByUser.get(userId);
    if (existingCall) {
        logger.warn('Call already in progress for user, rejecting new call', {
            userId,
            activeCall: existingCall.phoneNumber,
            requested: phoneNumber
        });
        return res.status(429).json({
            error: 'Call already in progress',
            activeCall: existingCall.phoneNumber
        });
    }

    try {
        const callId = await voiceApp.makeOutboundCall(phoneNumber, sipId, agentId, systemPrompt, voiceId);
        activeCallsByUser.set(userId, { callId, phoneNumber });

        logger.info('✅ Call initiated successfully', { callId, phoneNumber, agentId, userId });
        return res.json({ success: true, callId });
    } catch (error: any) {
        activeCallsByUser.delete(userId);
        logger.error('Failed to initiate call', { error: error.message, phoneNumber });
        return res.status(500).json({ error: 'Failed to initiate call' });
    }
});

// API: End a call
app.post('/api/end-call', async (req: any, res) => {
    const { callId } = req.body;
    if (!callId) {
        return res.status(400).json({ error: 'callId is required' });
    }

    const userId: number = req.user.id;
    try {
        await voiceApp.endCall(callId);

        const userCall = activeCallsByUser.get(userId);
        if (userCall?.callId === callId) {
            activeCallsByUser.delete(userId);
            logger.info('✅ Active call cleared', { callId, userId });
        }

        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to end call' });
    }
});

// API: Get active calls
app.get('/api/calls', (_req, res) => {
    return res.json({ activeCalls: voiceApp.getActiveCalls() });
});

// API: FreeSWITCH / SIP config info (safe read-only)
app.get('/api/sip/env-config', (_req, res) => {
    return res.json({
        username: config.sip.outbound.username,
        domain: config.sip.outbound.domain,
        port: config.sip.outbound.port,
        callerId: config.sip.outbound.callerId,
        freeswitchHost: config.freeswitch.host,
        freeswitchPort: config.freeswitch.port,
        sipGateway: config.freeswitch.sipGateway,
    });
});

// WebSocket: Test STT in real-time
(app as any).ws('/ws/test-stt', (ws: any) => {
    logger.info('🧪 STT Test WebSocket connected');
    const stt = new DeepgramSTTService();

    stt.on('connected', () => {
        ws.send(JSON.stringify({ type: 'status', message: 'Connected to Deepgram' }));
    });

    stt.on('transcript', (transcript: string) => {
        ws.send(JSON.stringify({ type: 'transcript', text: transcript, isFinal: true }));
    });

    stt.on('interim', (transcript: string) => {
        ws.send(JSON.stringify({ type: 'transcript', text: transcript, isFinal: false }));
    });

    stt.on('error', (error: any) => {
        ws.send(JSON.stringify({ type: 'error', message: error.message || 'STT Error' }));
    });

    ws.on('message', (data: any) => {
        if (Buffer.isBuffer(data)) {
            stt.sendAudio(data);
        } else if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'start') {
                    stt.connect().catch(err => {
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to connect: ' + err.message }));
                    });
                }
            } catch (e) {
                stt.sendAudio(Buffer.from(data));
            }
        }
    });

    ws.on('close', () => {
        logger.info('🧪 STT Test WebSocket closed');
        stt.disconnect();
    });
});

// WebSocket: Full AI conversation for browser testing
(app as any).ws('/ws/browser-talk', async (ws: any, req: any) => {
    logger.info('🧪 Browser Talk WebSocket connected');

    const agentId = req.query.agentId as string;
    const agent = agentId ? await agentService.getAgentInternal(agentId) : null;

    const stt = new DeepgramSTTService();
    const llm = new GroqLLMService();
    const tts = new SarvamTTSService();

    if (agent) {
        llm.setSystemPrompt(agent.systemPrompt);
        llm.setModel(agent.llmModel);
        llm.setTemperature(agent.temperature);
        llm.setMaxTokens(agent.maxTokens);

        tts.setSpeaker(agent.voiceId);
        tts.setModel(agent.ttsModel);
    } else if (req.query.systemPrompt) {
        llm.setSystemPrompt(req.query.systemPrompt as string);
        if (req.query.voiceId) tts.setSpeaker(req.query.voiceId as string);
    }

    let isProcessing = false;
    let abortController: AbortController | null = null;
    let interimStartTime = 0;
    let maxInterimWords = 0;

    const handleStreamingResponse = async (transcript: string | null) => {
        // Abort previous turn if still running
        if (abortController) {
            abortController.abort();
        }
        abortController = new AbortController();
        const signal = abortController.signal;

        isProcessing = true;

        try {
            ws.send(JSON.stringify({ type: 'status', message: 'AI is thinking...' }));
            const llmStream = llm.streamResponse(transcript, signal);
            const ttsStream = tts.streamSpeech(llmStream, signal);

            for await (const audioChunk of ttsStream) {
                if (signal.aborted) break;
                ws.send(audioChunk);
            }

            if (!signal.aborted) {
                ws.send(JSON.stringify({ type: 'status', message: 'Listening...' }));
            }
        } catch (error: any) {
            if (error.name === 'AbortError' || error.message?.includes('canceled')) {
                logger.info('Browser talk stream aborted');
            } else {
                ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
        } finally {
            if (abortController?.signal === signal) {
                isProcessing = false;
                abortController = null;
            }
        }
    };

    stt.on('connected', async () => {
        ws.send(JSON.stringify({ type: 'status', message: 'Connected' }));

        // Respect initial greeting delay
        if (agent?.startSpeakingPlan?.waitSeconds) {
            logger.info(`Waiting ${agent.startSpeakingPlan.waitSeconds}s before greeting in browser`);
            await new Promise(resolve => setTimeout(resolve, agent.startSpeakingPlan.waitSeconds * 1000));
        }

        handleStreamingResponse(null);
    });

    stt.on('transcript', async (transcript: string) => {
        // Reset barge-in tracking
        interimStartTime = 0;
        maxInterimWords = 0;

        ws.send(JSON.stringify({ type: 'transcript', text: transcript, isFinal: true }));

        // Respect turn-taking delays (Smart Endpointing)
        if (agent?.startSpeakingPlan?.smartEndpointing) {
            const words = transcript.trim().split(/\s+/);
            const lastWord = words[words.length - 1] || '';
            const hasPunctuation = /[?.!]$/.test(transcript.trim());
            const isNumber = /^\d+$/.test(lastWord.replace(/[?.!]/g, ''));

            let delay = agent.startSpeakingPlan.onNoPunctuationSeconds;
            if (hasPunctuation) delay = agent.startSpeakingPlan.onPunctuationSeconds;
            if (isNumber) delay = agent.startSpeakingPlan.onNumberSeconds;

            logger.info(`Turn-taking delay in browser: ${delay}s`, { transcript });
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }

        handleStreamingResponse(transcript);
    });

    stt.on('interim', (transcript: string) => {
        ws.send(JSON.stringify({ type: 'transcript', text: transcript, isFinal: false }));

        const isPlaying = tts.playing || isProcessing;
        if (!isPlaying) return;

        // Custom barge-in logic matching the pipeline
        if (!interimStartTime) interimStartTime = Date.now();
        const words = transcript.trim().split(/\s+/).length;
        if (words > maxInterimWords) maxInterimWords = words;
        const duration = (Date.now() - interimStartTime) / 1000;

        const thresholdWords = agent?.stopSpeakingPlan?.interruptionThresholdWords ?? 2;
        const thresholdSeconds = agent?.stopSpeakingPlan?.interruptionThresholdSeconds ?? 0.5;

        if (maxInterimWords >= thresholdWords || duration >= thresholdSeconds) {
            logger.info('Barge-in detected in browser', { words: maxInterimWords, duration });
            if (abortController) abortController.abort();
            tts.stop();
            ws.send(JSON.stringify({ type: 'barge-in' }));
        }
    });

    stt.on('error', (error: any) => {
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
    });

    ws.on('message', (data: any) => {
        if (Buffer.isBuffer(data)) {
            stt.sendAudio(data);
        } else if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'start') {
                    stt.connect().catch(err => ws.send(JSON.stringify({ type: 'error', message: err.message })));
                } else if (msg.type === 'stop') {
                    logger.info('Stop requested by browser');
                    if (abortController) abortController.abort();
                    tts.stop();
                    isProcessing = false;
                } else if (msg.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong' }));
                }
            } catch (e) {
                // Ignore
            }
        }
    });

    ws.on('close', () => {
        logger.info('🧪 Browser Talk WebSocket closed');
        if (abortController) abortController.abort();
        stt.disconnect();
        tts.stop();
        llm.clearHistory();
    });
});

// API: Test AI voice pipeline (without phone calls)
app.post('/api/test-voice', async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    try {
        logger.info('🧪 Testing AI voice pipeline', { text });

        const pipeline = new ConversationPipeline();
        const testCallId = `test-${Date.now()}`;

        await pipeline.start(testCallId);

        const llm = (pipeline as any).llm;
        let fullResponse = '';

        for await (const chunk of llm.streamResponse(text)) {
            fullResponse += chunk;
        }

        await pipeline.stop();

        logger.info('✅ Test complete', {
            input: text,
            response: fullResponse.substring(0, 100) + '...'
        });

        return res.json({
            success: true,
            input: text,
            response: fullResponse,
            note: 'AI pipeline tested successfully. TTS audio was generated but cannot be played via API.'
        });

    } catch (error: any) {
        logger.error('Test failed', { error: error.message });
        return res.status(500).json({ error: 'Test failed: ' + error.message });
    }
});

// Utility: Add WAV header to PCM data
function addWavHeader(pcmBuffer: Buffer, sampleRate: number = 16000): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmBuffer.length;
    const chunkSize = 36 + dataSize;

    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(chunkSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

// API: Test TTS directly
app.post('/api/test-tts', async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    try {
        logger.info('🧪 Testing Sarvam TTS', { text: text.substring(0, 50) });
        const tts = new SarvamTTSService();
        const pcmBuffer = await tts.generateSpeech(text);

        const wavBuffer = addWavHeader(pcmBuffer);

        res.set({
            'Content-Type': 'audio/wav',
            'Content-Length': wavBuffer.length
        });

        return res.send(wavBuffer);
    } catch (error: any) {
        logger.error('TTS Test failed', { error: error.message });
        return res.status(500).json({ error: 'TTS Test failed: ' + error.message });
    }
});

const PORT = config.app.port || 3000;
app.listen(PORT, () => {
    logger.info(`Voice Agent Server running on port ${PORT}`);
    logger.info(`Frontend available at http://localhost:${PORT}`);
    logger.info(`Test AI at http://localhost:${PORT}/test.html`);
    logger.info(`Test STT at http://localhost:${PORT}/test-stt.html`);
    logger.info(`Test TTS at http://localhost:${PORT}/test-tts.html`);
    logger.info(`FreeSWITCH ESL: ${config.freeswitch.host}:${config.freeswitch.port}`);
});

process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    voiceApp.stop();
    process.exit(0);
});

export { VoiceAgentApp };
