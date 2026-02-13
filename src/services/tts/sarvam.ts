import axios from 'axios';
import config from '../../config';
import logger from '../../utils/logger';
import { retry } from '../../utils/retry';
import { EventEmitter } from 'events';

/**
 * Sarvam.ai TTS Service
 * Handles text-to-speech conversion with streaming audio output
 */
export class SarvamTTSService extends EventEmitter {
    private baseUrl = 'https://api.sarvam.ai/text-to-speech';
    private isPlaying: boolean = false;
    private shouldStop: boolean = false;
    private speaker: string = 'shubh';
    private model: string = 'bulbul:v3';

    constructor() {
        super();
    }

    /**
     * Set a custom speaker
     */
    setSpeaker(speaker: string): void {
        this.speaker = speaker;
        logger.info('👤 Sarvam speaker updated', { speaker });
    }

    /**
     * Convert text to speech and return audio buffer
     * Uses streaming to minimize latency
     */
    async generateSpeech(text: string): Promise<Buffer> {
        try {
            logger.info('Generating speech', { text: text.substring(0, 50) });

            const response = await retry(
                () =>
                    axios.post(
                        this.baseUrl,
                        {
                            inputs: [text],
                            target_language_code: 'en-IN',
                            speaker: this.speaker,
                            pace: 1.0,
                            speech_sample_rate: 16000,
                            enable_preprocessing: true,
                            model: this.model,
                        },
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                'api-subscription-key': config.sarvam.apiKey,
                            },
                            responseType: 'arraybuffer',
                            timeout: 30000, // 30 second timeout
                        }
                    ),
                {
                    maxAttempts: 3,
                    delayMs: 1000,
                }
            );

            const audioBuffer = Buffer.from(response.data);

            // Sarvam API returns JSON even with arraybuffer responseType if it's not a direct stream
            // Check if it's JSON: {"audios": ["..."]}
            const responseText = audioBuffer.toString('utf8');
            if (responseText.trim().startsWith('{')) {
                const json = JSON.parse(responseText);
                if (json.audios && json.audios.length > 0) {
                    const base64Audio = json.audios[0];
                    const decodedAudio = Buffer.from(base64Audio, 'base64');
                    logger.info('Speech decoded from JSON', {
                        originalSize: audioBuffer.length,
                        decodedSize: decodedAudio.length
                    });
                    return decodedAudio;
                }
            }

            logger.info('Speech generated (raw)', { size: audioBuffer.length });
            return audioBuffer;
        } catch (error: any) {
            logger.error('Sarvam TTS error', {
                error: error.message,
                response: error.response?.data,
            });
            throw error;
        }
    }

    /**
     * Stream text chunks to TTS and emit audio chunks
     * Optimized for low latency by processing text as it arrives
     */
    async *streamSpeech(textChunks: AsyncGenerator<string>): AsyncGenerator<Buffer> {
        this.isPlaying = true;
        this.shouldStop = false;

        let buffer = '';
        const sentenceEndRegex = /[.!?]\s/;

        try {
            for await (const chunk of textChunks) {
                // Check if barge-in requested
                if (this.shouldStop) {
                    logger.info('TTS stopped due to barge-in');
                    this.isPlaying = false;
                    return;
                }

                buffer += chunk;

                // Process complete sentences to maintain natural speech
                const match = buffer.match(sentenceEndRegex);
                if (match) {
                    const sentence = buffer.substring(0, match.index! + match[0].length);
                    buffer = buffer.substring(match.index! + match[0].length);

                    // Generate speech for the sentence
                    const audio = await this.generateSpeech(sentence.trim());
                    yield audio;
                }
            }

            // Process remaining text
            if (buffer.trim().length > 0 && !this.shouldStop) {
                const audio = await this.generateSpeech(buffer.trim());
                yield audio;
            }

        } catch (error) {
            logger.error('Error in TTS streaming', { error });
            throw error;
        } finally {
            this.isPlaying = false;
        }
    }

    /**
     * Stop current TTS playback (barge-in)
     */
    stop(): void {
        if (this.isPlaying) {
            logger.info('Stopping TTS playback');
            this.shouldStop = true;
            this.emit('stopped');
        }
    }

    /**
     * Check if TTS is currently playing
     */
    get playing(): boolean {
        return this.isPlaying;
    }
}
