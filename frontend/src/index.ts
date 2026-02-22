import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import path from 'path';
import config from './config';
import logger from './utils/logger';
import { FreeSwitchService } from './services/freeswitch/FreeSwitchService';
import { SIPService } from './services/sip';
import { SIPGateway } from './services/sip-gateway';
import { ConversationPipeline } from './services/conversation/pipeline';
import { DeepgramSTTService } from './services/stt/deepgram';
import { SarvamTTSService } from './services/tts/sarvam';

/**
 * AI Voice Agent Backend — FreeSWITCH Edition
 * All call handling (inbound + outbound) is done via FreeSWITCH (drachtio-srf ESL).
 * Audio pipeline: FreeSWITCH RTP ↔ Deepgram STT → Groq LLM → Sarvam TTS ↔ FreeSWITCH RTP
 */
class VoiceAgentApp {
    private freeSwitchService: FreeSwitchService;
    private sipService: SIPService;
    private sipGateway: SIPGateway;
    private activePipelines: Map<string, ConversationPipeline> = new Map();

    constructor() {
        // Initialize FreeSWITCH ESL service
        this.freeSwitchService = new FreeSwitchService();
        this.sipService = new SIPService(this.freeSwitchService);

        // Initialize Local SIP Gateway for Inbound Registration
        this.sipGateway = new SIPGateway();
        this.sipGateway.start().catch(err => {
            logger.error('Failed to start SIP Gateway', { error: err.message });
        });

        // Wire inbound calls from local SIP Gateway
        this.sipGateway.on('inboundCall', (data) => {
            logger.info('📞 Inbound call received via local SIP Gateway', { callId: data.callId });
            // The gateway handles its own pipeline, but we track it here
            this.activePipelines.set(data.callId, (data.session as any).pipeline);
        });

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
    }

    async makeOutboundCall(phoneNumber: string, systemPrompt?: string, voiceId?: string): Promise<string> {
        try {
            logger.info('Making outbound call', { phoneNumber });

            const callId = `call-${Date.now()}`;

            // Start conversation pipeline first to get local RTP port
            const pipeline = new ConversationPipeline();
            if (systemPrompt) (pipeline as any).llm?.setSystemPrompt?.(systemPrompt);
            if (voiceId) (pipeline as any).tts?.setSpeaker?.(voiceId);

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

            // Initiate call via FreeSWITCH with our SDP and pre-generated callId
            await this.sipService.makeOutboundCall(phoneNumber, localSdp, callId);

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

    stop(): void {
        this.sipGateway.stop();
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

// API: Start an outbound call
app.post('/api/call', async (req, res) => {
    const { phoneNumber } = req.body;
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
        const { systemPrompt, voiceId } = req.body;
        const callId = await voiceApp.makeOutboundCall(phoneNumber, systemPrompt, voiceId);
        activeCall = { callId, phoneNumber };

        logger.info('✅ Call initiated successfully', { callId, phoneNumber });
        return res.json({ success: true, callId });
    } catch (error) {
        activeCall = null;
        logger.error('Failed to initiate call', { error, phoneNumber });
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
        username: config.sip.username,
        domain: config.sip.domain,
        port: config.sip.port,
        callerId: config.sip.callerId,
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
