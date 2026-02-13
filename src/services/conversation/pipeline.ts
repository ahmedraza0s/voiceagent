import { DeepgramSTTService } from '../stt/deepgram';
import { GroqLLMService } from '../llm/groq';
import { SarvamTTSService } from '../tts/sarvam';
import { LiveKitRoomService } from '../rooms/livekit';
import logger from '../../utils/logger';
import { EventEmitter } from 'events';

/**
 * Conversation Pipeline
 * Orchestrates the complete streaming pipeline:
 * Audio → STT → LLM → TTS → Audio
 * 
 * Note: For production, you would connect a LiveKit client participant
 * to handle actual audio streaming. This demonstrates the pipeline logic.
 */
export class ConversationPipeline extends EventEmitter {
    private stt: DeepgramSTTService;
    private llm: GroqLLMService;
    private tts: SarvamTTSService;
    private room: LiveKitRoomService;
    private isProcessing: boolean = false;
    private roomName: string | null = null;

    constructor() {
        super();
        this.stt = new DeepgramSTTService();
        this.llm = new GroqLLMService();
        this.tts = new SarvamTTSService();
        this.room = new LiveKitRoomService();

        this.setupPipeline();
    }

    /**
     * Set up the complete streaming pipeline
     */
    private setupPipeline(): void {
        // Step 1: Handle transcripts from STT
        this.stt.on('transcript', async (transcript: string) => {
            await this.handleTranscript(transcript);
        });

        // Handle interim results for barge-in detection
        this.stt.on('interim', (interim: string) => {
            // If the user starts speaking, we should signal a potential barge-in
            // This will clear buffered audio even if the TTS generation has finished
            if (this.tts.playing || this.isProcessing) {
                logger.info('User speaking - signaling potential barge-in', { interim });
                this.tts.stop();
                this.emit('bargeIn', interim);
            }
        });

        // Step 2-4: Handle errors from services
        this.stt.on('error', (error: any) => {
            logger.error('STT service error', { error: error.message || error });
            this.emit('error', error);
        });

        this.tts.on('error', (error: any) => {
            logger.error('TTS service error', { error: error.message || error });
            this.emit('error', error);
        });
    }

    /**
     * Trigger an initial greeting from the AI
     * Called when the call is first connected
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

            // Step 2 & 3: Get streaming response from LLM
            const llmStream = this.llm.streamResponse(transcript);

            // Step 4 & 5: Convert LLM response to speech
            const ttsStream = this.tts.streamSpeech(llmStream);

            // Step 6: Stream audio chunks
            // In production, these would be published to LiveKit
            for await (const audioChunk of ttsStream) {
                // Placeholder: In production, publish to LiveKit participant
                logger.debug('Audio chunk ready for streaming', { size: audioChunk.length });
                this.emit('audioChunk', audioChunk);
            }

            logger.info('Response complete');
            this.emit('responseComplete');

        } catch (error: any) {
            logger.error('Error in conversation pipeline', {
                message: error.message,
                stack: error.stack
            });
            this.emit('error', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Start the conversation pipeline
     */
    async start(roomName: string, systemPrompt?: string, voiceId?: string): Promise<void> {
        try {
            logger.info('Starting conversation pipeline', {
                roomName,
                hasCustomPrompt: !!systemPrompt,
                voiceId
            });
            this.roomName = roomName;

            if (systemPrompt) {
                this.llm.setSystemPrompt(systemPrompt);
            }

            if (voiceId) {
                this.tts.setSpeaker(voiceId);
            }

            // Verify room exists
            const exists = await this.room.roomExists(roomName);
            if (!exists) {
                await this.room.createRoom(roomName);
            }

            // Connect to Deepgram STT
            await this.stt.connect();

            logger.info('Conversation pipeline ready');
            logger.info('NOTE: For production, connect a LiveKit participant to handle audio I/O');
            this.emit('ready');

        } catch (error) {
            logger.error('Failed to start conversation pipeline', { error });
            throw error;
        }
    }

    /**
     * Process audio from external source (e.g., LiveKit participant)
     */
    processAudio(audioBuffer: Buffer): void {
        this.stt.sendAudio(audioBuffer);
    }

    /**
     * Stop the conversation pipeline
     */
    async stop(): Promise<void> {
        try {
            logger.info('Stopping conversation pipeline', { roomName: this.roomName });

            // Stop TTS if playing
            this.tts.stop();

            // Disconnect from services
            await this.stt.disconnect();

            // Clear LLM history
            this.llm.clearHistory();

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
}
