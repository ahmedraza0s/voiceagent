
import { DeepgramSTTService } from '../stt/deepgram';
import { GroqLLMService } from '../llm/groq';
import { SarvamTTSService } from '../tts/sarvam';
import { FreeSwitchAudioBridge } from '../freeswitch/FreeSwitchAudioBridge';
import logger from '../../utils/logger';
import { EventEmitter } from 'events';

/**
 * Conversation Pipeline
 * Orchestrates the complete streaming pipeline:
 * Audio → STT → LLM → TTS → Audio
 *
 * Audio I/O is now handled by FreeSwitchAudioBridge (RTP ↔ FreeSWITCH) instead of LiveKit.
 */
export class ConversationPipeline extends EventEmitter {
    private stt: DeepgramSTTService;
    private llm: GroqLLMService;
    private tts: SarvamTTSService;
    private bridge: FreeSwitchAudioBridge;
    private isProcessing: boolean = false;
    private callId: string | null = null;

    constructor(localRtpPort: number = 0) {
        super();
        this.stt = new DeepgramSTTService();
        this.llm = new GroqLLMService();
        this.tts = new SarvamTTSService();
        this.bridge = new FreeSwitchAudioBridge(localRtpPort);

        this.setupPipeline();
    }

    /**
     * Set up the complete streaming pipeline
     */
    private setupPipeline(): void {
        // Step 1: Handle audio from FreeSWITCH (caller speaking)
        this.bridge.on('audio', (pcmBuffer: Buffer) => {
            if (this.stt) {
                this.stt.sendAudio(pcmBuffer);
            }
        });

        // Step 2: Handle transcripts from STT
        this.stt.on('transcript', async (transcript: string) => {
            await this.handleTranscript(transcript);
        });

        // Handle interim results for barge-in detection
        this.stt.on('interim', (interim: string) => {
            if (this.tts.playing || this.isProcessing) {
                logger.info('User speaking - signaling potential barge-in', { interim });
                this.tts.stop();
                this.emit('bargeIn', interim);
            }
        });

        // Handle errors
        this.stt.on('error', (error: any) => this.handleError('STT', error));
        this.tts.on('error', (error: any) => this.handleError('TTS', error));

        this.bridge.on('error', (error: any) => this.handleError('AudioBridge', error));
    }

    private handleError(service: string, error: any): void {
        logger.error(`${service} service error`, { error: error.message || error });
        this.emit('error', error);
    }

    /**
     * Trigger an initial greeting from the AI
     */
    async sayHello(): Promise<void> {
        logger.info('👋 Triggering initial AI greeting');
        await this.handleTranscript(null); // null triggers dynamic greeting from LLM
    }

    /**
     * Process transcript through LLM and TTS
     */
    private async handleTranscript(transcript: string | null): Promise<void> {
        if (this.isProcessing) {
            logger.warn('Already processing, skipping transcript');
            return;
        }

        this.isProcessing = true;

        try {
            logger.info('Processing transcript', { transcript });
            this.emit('transcriptReceived', transcript);

            // Step 3: Get streaming response from LLM
            const llmStream = this.llm.streamResponse(transcript);

            // Step 4: Convert LLM response to speech
            const ttsStream = this.tts.streamSpeech(llmStream);

            // Step 5: Stream audio chunks to FreeSWITCH via RTP
            for await (const audioChunk of ttsStream) {
                this.bridge.pushAudio(audioChunk);
                this.emit('audioChunk', audioChunk);
            }

            logger.info('Response complete');
            this.emit('responseComplete');

        } catch (error: any) {
            this.handleError('Pipeline', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Start the conversation pipeline
     * @param callId - FreeSWITCH call UUID or unique call identifier
     * @param remoteRtpAddress - FreeSWITCH media IP (from SDP)
     * @param remoteRtpPort - FreeSWITCH media port (from SDP)
     * @param systemPrompt - optional system prompt override
     * @param voiceId - optional TTS voice override
     */
    async start(
        callId: string,
        remoteRtpAddress?: string,
        remoteRtpPort?: number,
        systemPrompt?: string,
        voiceId?: string
    ): Promise<void> {
        try {
            logger.info('Starting conversation pipeline', { callId });
            this.callId = callId;

            if (systemPrompt) this.llm.setSystemPrompt(systemPrompt);
            if (voiceId) this.tts.setSpeaker(voiceId);

            // Connect to Deepgram STT
            await this.stt.connect();

            // Start the RTP bridge
            await this.bridge.start();

            // Set remote endpoint if provided (from SDP negotiation)
            if (remoteRtpAddress && remoteRtpPort) {
                this.bridge.setRemoteEndpoint(remoteRtpAddress, remoteRtpPort);
            }

            logger.info('Conversation pipeline ready', { callId, localRtpPort: this.bridge.localRtpPort });
            this.emit('ready');

        } catch (error) {
            logger.error('Failed to start conversation pipeline', { error });
            throw error;
        }
    }

    /**
     * Stop the conversation pipeline
     */
    async stop(): Promise<void> {
        try {
            logger.info('Stopping conversation pipeline', { callId: this.callId });

            this.tts.stop();
            await this.stt.disconnect();
            this.llm.clearHistory();
            this.bridge.stop();

            logger.info('Conversation pipeline stopped');
            this.emit('stopped');

        } catch (error) {
            logger.error('Error stopping conversation pipeline', { error });
        }
    }

    /**
     * Get the local RTP port this pipeline is listening on
     */
    get localRtpPort(): number {
        return this.bridge.localRtpPort;
    }

    /**
     * Get conversation history
     */
    getHistory(): any[] {
        return this.llm.getHistory();
    }

    // Legacy method support
    processAudio(_audioBuffer: Buffer): void {
        // No-op, handled by bridge event
    }
}
