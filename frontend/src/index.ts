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
import { agentService } from './services/agents/AgentService';
import { sipSettingsService, SipSettings } from './services/sip/SipSettingsService';

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
            const settings = sipSettingsService.listSettings();
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
            const sipSettings = sipId ? sipSettingsService.getSettings(sipId) : undefined;

            // Look up agent config
            // Priority: agentId -> sipSettings.inboundAgentId (mapping) -> default inbound
            const agent = agentId ? agentService.getAgent(agentId) :
                (sipSettings?.inboundAgentId ? agentService.getAgent(sipSettings.inboundAgentId) : agentService.getInboundAgent());

            if (agent) {
                logger.info('Using agent configuration', { agentName: agent.name });
                (pipeline as any).llm?.setSystemPrompt?.(agent.systemPrompt);
                (pipeline as any).tts?.setSpeaker?.(agent.voiceId);
            } else if (systemPrompt || voiceId) {
                if (systemPrompt) (pipeline as any).llm?.setSystemPrompt?.(systemPrompt);
                if (voiceId) (pipeline as any).tts?.setSpeaker?.(voiceId);
            }

            // Register the pipeline IMMEDIATELY to avoid race conditions with events
            this.activePipelines.set(callId, pipeline);
            this.setupPipelineEvents(pipeline, callId);

            // We need to start the bridge to get the port
            await (pipeline as any).bridge.start();
            const localPort = pipeline.localRtpPort;

            // Use SIP_PUBLIC_IP if available (especially for Docker networking), otherwise local
            const localIp = process.env.SIP_PUBLIC_IP || process.env.LOCAL_IP || '127.0.0.1';
            const localSdp = FreeSwitchService.generateSdp(localIp, localPort);

            logger.info('Starting outbound call via SIP Service', { callId, localPort, localIp });

            // Initiate call via FreeSWITCH with our SDP and pre-generated callId and selective settings
            await this.sipService.makeOutboundCall(phoneNumber, localSdp, callId, sipSettings);

            // STT etc can start now
            await (pipeline as any).stt.connect();

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

            // Identify which SIP account this call came for
            // We'll check the 'To' header which usually contains the dialed number in some form
            const toHeader = req.get('To') || '';
            const allSipSettings = sipSettingsService.listSettings();

            // Try to find matching SIP setting by username or callerId in the To header
            const matchedSip = allSipSettings.find(s =>
                toHeader.includes(s.username) || (s.callerId && toHeader.includes(s.callerId))
            );

            // Use mapped agent or fallback to global Inbound Agent
            let agentId = matchedSip?.inboundAgentId;
            let agent = agentId ? agentService.getAgent(agentId) : agentService.getInboundAgent();

            if (agent) {
                logger.info('Assigning agent for inbound call', {
                    agentName: agent.name,
                    sipUsername: matchedSip?.username || 'unknown'
                });
                (pipeline as any).llm?.setSystemPrompt?.(agent.systemPrompt);
                (pipeline as any).tts?.setSpeaker?.(agent.voiceId);
            }

            this.activePipelines.set(callId, pipeline);

            // Start bridge to get local port
            await (pipeline as any).bridge.start();
            const localPort = pipeline.localRtpPort;
            const localIp = process.env.LOCAL_IP || '127.0.0.1';
            const localSdp = FreeSwitchService.generateSdp(localIp, localPort);

            // Answer via FreeSWITCH
            await this.freeSwitchService.answerInboundCall(req, res, localSdp);

            // Parse remote SDP to know where to send audio back
            if (req.body) {
                const { address, port } = FreeSwitchService.parseSdp(req.body);
                (pipeline as any).bridge.setRemoteEndpoint(address, port);
            }

            this.setupPipelineEvents(pipeline, callId);
            await (pipeline as any).stt.connect();

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

// Track active call to prevent duplicates/loops
let activeCall: { callId: string; phoneNumber: string } | null = null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// --- Agent Management API ---

// List all agents
app.get('/api/agents', (_req, res) => {
    res.json(agentService.listAgents());
});

// Get current inbound agent
app.get('/api/agents/inbound', (_req, res) => {
    res.json(agentService.getInboundAgent() || { error: 'No inbound agent set' });
});

// Get single agent
app.get('/api/agents/:id', (req, res) => {
    const agent = agentService.getAgent(req.params.id);
    return agent ? res.json(agent) : res.status(404).json({ error: 'Agent not found' });
});

// Create/Update agent
app.post('/api/agents', (req, res) => {
    const { id, name, systemPrompt, voiceId } = req.body;
    if (!name || !systemPrompt || !voiceId) {
        return res.status(400).json({ error: 'Name, systemPrompt, and voiceId are required' });
    }

    if (id) {
        const updated = agentService.updateAgent(id, { name, systemPrompt, voiceId });
        return updated ? res.json(updated) : res.status(404).json({ error: 'Agent not found' });
    } else {
        const created = agentService.createAgent(name, systemPrompt, voiceId);
        return res.json(created);
    }
});

// Set inbound agent
app.post('/api/agents/set-inbound', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Agent ID is required' });

    const success = agentService.setInboundAgent(id);
    return success ? res.json({ success: true }) : res.status(404).json({ error: 'Agent not found' });
});

// Delete agent
app.delete('/api/agents/:id', (req, res) => {
    const success = agentService.deleteAgent(req.params.id);
    return success ? res.json({ success: true }) : res.status(404).json({ error: 'Agent not found' });
});

// --- SIP Settings Management API ---

// List all SIP settings
app.get('/api/sip-settings', (_req, res) => {
    res.json(sipSettingsService.listSettings());
});

// Create/Update SIP settings
app.post('/api/sip-settings', async (req, res) => {
    const { id, name, username, password, domain, port, callerId, proxy, inboundAgentId } = req.body;
    if (!name || !username || !domain || !port) {
        return res.status(400).json({ error: 'Name, username, domain, and port are required' });
    }

    if (id) {
        const updated = sipSettingsService.updateSettings(id, {
            name, username, password, domain, port, callerId, proxy, inboundAgentId
        });
        if (updated) {
            // Re-register if settings updated
            await voiceApp.registerSipAccount(updated);
            return res.json(updated);
        }
        return res.status(404).json({ error: 'Settings not found' });
    } else {
        const created = sipSettingsService.createSettings({
            name, username, password, domain, port, callerId, proxy, inboundAgentId
        });
        // Register new account
        await voiceApp.registerSipAccount(created);
        return res.json(created);
    }
});

// Delete SIP settings
app.delete('/api/sip-settings/:id', async (req, res) => {
    const id = req.params.id;
    await voiceApp.unregisterSipAccount(id);
    const success = sipSettingsService.deleteSettings(id);
    return success ? res.json({ success: true }) : res.status(404).json({ error: 'Settings not found' });
});

// --- Call Control API ---
app.post('/api/call', async (req, res) => {
    const { phoneNumber, sipId, agentId, systemPrompt, voiceId } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    if (activeCall) {
        logger.warn('Call already in progress, rejecting new call', {
            activeCall: activeCall.phoneNumber,
            requested: phoneNumber
        });
        return res.status(429).json({
            error: 'Call already in progress',
            activeCall: activeCall.phoneNumber
        });
    }

    try {
        const callId = await voiceApp.makeOutboundCall(phoneNumber, sipId, agentId, systemPrompt, voiceId);
        activeCall = { callId, phoneNumber };

        logger.info('✅ Call initiated successfully', { callId, phoneNumber, agentId });
        return res.json({ success: true, callId });
    } catch (error: any) {
        activeCall = null;
        logger.error('Failed to initiate call', { error: error.message, phoneNumber });
        return res.status(500).json({ error: 'Failed to initiate call' });
    }
});

// API: End a call
app.post('/api/end-call', async (req, res) => {
    const { callId } = req.body;
    if (!callId) {
        return res.status(400).json({ error: 'callId is required' });
    }

    try {
        await voiceApp.endCall(callId);

        if (activeCall?.callId === callId) {
            activeCall = null;
            logger.info('✅ Active call cleared', { callId });
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
