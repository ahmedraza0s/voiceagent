import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import config from '../../config';
import logger from '../../utils/logger';
import { EventEmitter } from 'events';

/**
 * Deepgram Speech-to-Text Service
 * Handles streaming audio transcription with interim results
 */
export class DeepgramSTTService extends EventEmitter {
    private client: ReturnType<typeof createClient>;
    private connection: any;
    private isConnected: boolean = false;

    constructor() {
        super();
        this.client = createClient(config.deepgram.apiKey);
    }

    /**
     * Start streaming transcription session
     */
    async connect(): Promise<void> {
        try {
            logger.info('Connecting to Deepgram STT...');

            this.connection = this.client.listen.live({
                model: 'nova-2',
                language: 'en-US',
                smart_format: true,
                interim_results: true,
                utterance_end_ms: 1000,
                vad_events: true,
                encoding: 'linear16',
                sample_rate: 16000,
            });

            // Handle transcript events
            this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
                const transcript = data.channel?.alternatives?.[0]?.transcript;

                if (transcript && transcript.trim().length > 0) {
                    const isFinal = data.is_final;

                    logger.debug('STT result', {
                        transcript,
                        isFinal,
                        confidence: data.channel?.alternatives?.[0]?.confidence,
                    });

                    if (isFinal) {
                        // Emit final transcript
                        this.emit('transcript', transcript);
                    } else {
                        // Emit interim transcript
                        this.emit('interim', transcript);
                    }
                }
            });

            // Handle connection events
            this.connection.on(LiveTranscriptionEvents.Open, () => {
                this.isConnected = true;
                logger.info('Deepgram STT connected');
                this.emit('connected');
            });

            this.connection.on(LiveTranscriptionEvents.Close, () => {
                this.isConnected = false;
                logger.info('Deepgram STT disconnected');
                this.emit('disconnected');
            });

            this.connection.on(LiveTranscriptionEvents.Error, (error: any) => {
                logger.error('Deepgram STT error', { error: error.message });
                this.emit('error', error);
            });

            // Handle utterance end (user stopped speaking)
            this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
                logger.debug('Utterance end detected');
                this.emit('utteranceEnd');
            });

        } catch (error) {
            logger.error('Failed to connect to Deepgram', { error });
            throw error;
        }
    }

    /**
     * Send audio data to Deepgram for transcription
     * @param audioChunk - Raw audio buffer (16-bit PCM, 16kHz)
     */
    sendAudio(audioChunk: Buffer): void {
        if (!this.isConnected || !this.connection) {
            logger.warn('Deepgram not connected, skipping audio send');
            return;
        }

        try {
            this.connection.send(audioChunk);
        } catch (error) {
            logger.error('Error sending audio to Deepgram', { error });
        }
    }

    /**
     * Close the Deepgram connection
     */
    async disconnect(): Promise<void> {
        if (this.connection) {
            logger.info('Disconnecting from Deepgram...');
            this.connection.finish();
            this.isConnected = false;
        }
    }

    /**
     * Check if currently connected
     */
    get connected(): boolean {
        return this.isConnected;
    }
}
