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

    private audioBuffer: Buffer[] = [];

    constructor() {
        super();
        this.client = createClient(config.deepgram.apiKey);
    }

    /**
     * Start streaming transcription session
     */
    async connect(): Promise<void> {
        if (this.isConnected) return;

        return new Promise((resolve, reject) => {
            try {
                logger.info('Connecting to Deepgram STT...');

                this.connection = this.client.listen.live({
                    model: 'nova-2',
                    language: 'en-US',
                    punctuate: true,
                    interim_results: true,
                    utterance_end_ms: 1000,
                    vad_events: true,
                    encoding: 'linear16',
                    sample_rate: 16000,
                });

                const timeout = setTimeout(() => {
                    if (!this.isConnected) {
                        logger.error('Deepgram connection timeout after 5s');
                        reject(new Error('Deepgram connection timeout'));
                    }
                }, 5000);

                // Handle connection events
                this.connection.on(LiveTranscriptionEvents.Open, () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    logger.info('Deepgram STT connected');

                    // Drain buffer
                    if (this.audioBuffer.length > 0) {
                        logger.info(`Draining ${this.audioBuffer.length} buffered audio chunks to Deepgram`);
                        this.audioBuffer.forEach(chunk => this.connection.send(chunk));
                        this.audioBuffer = [];
                    }

                    this.emit('connected');
                    resolve();
                });

                this.connection.on(LiveTranscriptionEvents.Error, (error: any) => {
                    clearTimeout(timeout);
                    logger.error('Deepgram STT error', { error: error.message || error });
                    this.emit('error', error);
                    if (!this.isConnected) reject(error);
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
                            this.emit('transcript', transcript);
                        } else {
                            this.emit('interim', transcript);
                        }
                    }
                });

                this.connection.on(LiveTranscriptionEvents.Close, () => {
                    this.isConnected = false;
                    logger.info('Deepgram STT disconnected');
                    this.emit('disconnected');
                });

                this.connection.on(LiveTranscriptionEvents.Metadata, (data: any) => {
                    logger.info('Deepgram Metadata received', { data });
                });

                this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
                    logger.debug('Utterance end detected');
                    this.emit('utteranceEnd');
                });

            } catch (error) {
                logger.error('Failed to initiate Deepgram connection', { error });
                reject(error);
            }
        });
    }

    /**
     * Send audio data to Deepgram for transcription
     * @param audioChunk - Raw audio buffer (16-bit PCM, 16kHz)
     */
    sendAudio(audioChunk: Buffer): void {
        if (!this.isConnected || !this.connection) {
            // Buffer up to 10 seconds of audio (approx 200 chunks if each is 50ms)
            if (this.audioBuffer.length < 200) {
                if (this.audioBuffer.length === 0) {
                    logger.debug('Buffering audio until Deepgram connects...');
                }
                this.audioBuffer.push(audioChunk);
            }
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
