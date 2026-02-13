
import { DeepgramSTTService } from '../stt/deepgram';
import { GroqLLMService } from '../llm/groq';
import { SarvamTTSService } from '../tts/sarvam';
import { LiveKitRoomService } from '../rooms/livekit';
import { LiveKitAgent } from '../rooms/livekit-agent';
import logger from '../../utils/logger';
import { EventEmitter } from 'events';

/**
 * Conversation Pipeline
 * Orchestrates the complete streaming pipeline:
 * Audio → STT → LLM → TTS → Audio
 */
export class ConversationPipeline extends EventEmitter {
    private stt: DeepgramSTTService;
    private llm: GroqLLMService;
    private tts: SarvamTTSService;
    private room: LiveKitRoomService;
    private agent: LiveKitAgent;
    private isProcessing: boolean = false;
    private roomName: string | null = null;

    constructor() {
        super();
        this.stt = new DeepgramSTTService();
        this.llm = new GroqLLMService();
        this.tts = new SarvamTTSService();
        this.room = new LiveKitRoomService();
        this.agent = new LiveKitAgent();

        this.setupPipeline();
    }

    /**
     * Set up the complete streaming pipeline
     */
    private setupPipeline(): void {
        // Step 1: Handle audio from LiveKit Agent (User speaking)
        this.agent.on('audio', (pcmBuffer: Buffer) => {
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
            // If the user starts speaking, signal barge-in
            if (this.tts.playing || this.isProcessing) {
                logger.info('User speaking - signaling potential barge-in', { interim });
                this.tts.stop();
                this.emit('bargeIn', interim);
            }
        });

        // Handle errors
        this.stt.on('error', (error: any) => this.handleError('STT', error));
        this.tts.on('error', (error: any) => this.handleError('TTS', error));

        // Agent events
        this.agent.on('disconnected', () => {
            logger.info('Agent disconnected from room');
            this.stop(); // Stop pipeline if agent disconnects
        });
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
        await this.handleTranscript(null); // Passing null triggers dynamic greeting from LLM
    }

    /**
     * Process transcript through LLM and TTS
     */
    private async handleTranscript(transcript: string | null): Promise<void> {
        if (this.isProcessing) {
            logger.warn('Already processing, queuing transcript');
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

            // Step 5: Stream audio chunks to LiveKit
            for await (const audioChunk of ttsStream) {
                // Publish to LiveKit participant
                // logger.debug('Audio chunk ready for streaming');
                await this.agent.pushAudio(audioChunk);
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
     */
    async start(roomName: string, systemPrompt?: string, voiceId?: string): Promise<void> {
        try {
            logger.info('Starting conversation pipeline', { roomName });
            this.roomName = roomName;

            if (systemPrompt) this.llm.setSystemPrompt(systemPrompt);
            if (voiceId) this.tts.setSpeaker(voiceId);

            // Connect to Deepgram STT
            await this.stt.connect();

            // Connect Agent to LiveKit Room
            // We use a slight delay or retry logic if the room isn't ready immediately?
            // Usually createRoom is fast.
            await this.agent.connect(roomName, 'AI Assistant');

            logger.info('Conversation pipeline ready');
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
            logger.info('Stopping conversation pipeline', { roomName: this.roomName });

            this.tts.stop();
            await this.stt.disconnect();
            this.llm.clearHistory();
            await this.agent.disconnect();

            logger.info('Conversation pipeline stopped');
            this.emit('stopped');

        } catch (error) {
            logger.error('Error stopping conversation pipeline', { error });
        }
    }

    /**
     * Get conversation history
     */
    getHistory(): any[] {
        return this.llm.getHistory();
    }

    // Legacy method support if needed, or remove
    processAudio(audioBuffer: Buffer): void {
        // No-op, handled by agent event
    }
}
