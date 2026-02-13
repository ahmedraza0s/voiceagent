import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import path from 'path';
import config from './config';
import logger from './utils/logger';
import { SIPService } from './services/sip';
import { ConversationPipeline } from './services/conversation/pipeline';
import { DeepgramSTTService } from './services/stt/deepgram';
import { SarvamTTSService } from './services/tts/sarvam';

/**
 * AI Voice Agent Backend
 */
class VoiceAgentApp {
    private sipService: SIPService;
    private activePipelines: Map<string, ConversationPipeline> = new Map();

    constructor() {
        this.sipService = new SIPService();
    }

    async makeOutboundCall(phoneNumber: string, systemPrompt?: string, voiceId?: string): Promise<string> {
        try {
            logger.info('Making outbound call', { phoneNumber });
            const roomName = await this.sipService.makeOutboundCall(phoneNumber);
            const pipeline = new ConversationPipeline();

            // Trigger greeting when call is actually connected
            this.sipService.once('callConnected', async (data) => {
                if (data.callId === roomName) {
                    logger.info('📞 Call connected for user, triggering greeting');
                    await pipeline.sayHello();
                }
            });

            this.setupPipelineEvents(pipeline, roomName);
            await pipeline.start(roomName, systemPrompt, voiceId);
            this.activePipelines.set(roomName, pipeline);
            return roomName;
        } catch (error) {
            logger.error('Failed to make outbound call', { error });
            throw error;
        }
    }

    async handleInboundCall(callId: string): Promise<void> {
        try {
            logger.info('Handling inbound call', { callId });
            const roomName = await this.sipService.handleInboundCall(callId);
            const pipeline = new ConversationPipeline();
            this.setupPipelineEvents(pipeline, roomName);
            // Dynamic identity not support for anonymous inbound calls yet
            await pipeline.start(roomName);
            this.activePipelines.set(roomName, pipeline);
        } catch (error) {
            logger.error('Failed to handle inbound call', { error });
            throw error;
        }
    }

    private setupPipelineEvents(pipeline: ConversationPipeline, roomName: string): void {
        pipeline.on('ready', () => logger.info('Pipeline ready', { roomName }));
        pipeline.on('transcriptReceived', (transcript: string) => {
            logger.info('User said:', { transcript, roomName });
            // Backup: Clear audio on final transcript too
            this.sipService.stopAudio();
        });
        pipeline.on('bargeIn', (interim: string) => {
            logger.info('User interrupted', { interim, roomName });
            this.sipService.stopAudio();
        });
        pipeline.on('responseComplete', () =>
            logger.info('AI response complete', { roomName }));

        // Audio Bridge: SIP -> AI
        const audioHandler = (data: { callId: string; pcm16: Buffer }) => {
            if (data.callId === roomName) {
                pipeline.processAudio(data.pcm16);
            }
        };
        this.sipService.on('audio', audioHandler);

        // Audio Bridge: AI -> SIP
        pipeline.on('audioChunk', (audio: Buffer) => {
            this.sipService.sendAudio(audio);
        });

        pipeline.on('stopped', async () => {
            logger.info('Pipeline stopped', { roomName });

            // Cleanup: remove audio listener
            this.sipService.off('audio', audioHandler);

            this.activePipelines.delete(roomName);
            await this.sipService.deleteRoom(roomName);
        });
        pipeline.on('error', (error: Error) =>
            logger.error('Pipeline error', { error, roomName }));
    }

    async endCall(roomName: string): Promise<void> {
        const pipeline = this.activePipelines.get(roomName);
        if (pipeline) {
            await pipeline.stop();
            this.activePipelines.delete(roomName);
        }
    }

    getActiveCalls(): string[] {
        return Array.from(this.activePipelines.keys());
    }
}

const { app } = expressWs(express());
const voiceApp = new VoiceAgentApp();

// Track active call to prevent duplicates/loops
let activeCall: { roomName: string; phoneNumber: string } | null = null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API: Start a call
app.post('/api/call', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    // Prevent duplicate/looping calls
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
        const roomName = await voiceApp.makeOutboundCall(phoneNumber, systemPrompt, voiceId);
        activeCall = { roomName, phoneNumber };

        logger.info('✅ Call initiated successfully', { roomName, phoneNumber });
        return res.json({ success: true, roomName });
    } catch (error) {
        activeCall = null;
        logger.error('Failed to initiate call', { error, phoneNumber });
        return res.status(500).json({ error: 'Failed to initiate call' });
    }
});

// API: End a call
app.post('/api/end-call', async (req, res) => {
    const { roomName } = req.body;
    if (!roomName) {
        return res.status(400).json({ error: 'Room name is required' });
    }

    try {
        await voiceApp.endCall(roomName);

        // Clear active call state
        if (activeCall?.roomName === roomName) {
            activeCall = null;
            logger.info('✅ Active call cleared', { roomName });
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
        // Assume binary data is audio chunk
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
                // Not JSON, maybe raw audio as string (rare but handleable)
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
        const testRoom = `test-${Date.now()}`;

        // Start pipeline
        await pipeline.start(testRoom);

        // Manually trigger the pipeline (bypass STT, directly inject text)
        logger.info('Simulating user speech:', text);

        // Access the internal LLM to get response
        const llm = (pipeline as any).llm;
        let fullResponse = '';

        for await (const chunk of llm.streamResponse(text)) {
            fullResponse += chunk;
        }

        // Clean up
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
    header.writeUInt32LE(16, 16); // Subchunk1Size
    header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
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

        // Browser needs WAV header to play raw PCM
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
});

process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    for (const room of voiceApp.getActiveCalls()) {
        await voiceApp.endCall(room);
    }
    process.exit(0);
});

export { VoiceAgentApp };

