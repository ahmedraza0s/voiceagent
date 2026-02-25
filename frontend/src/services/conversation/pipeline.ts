
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

    // Speaking Plans
    private startSpeakingPlan: import('../agents/AgentService').StartSpeakingPlan | null = null;
    private stopSpeakingPlan: import('../agents/AgentService').StopSpeakingPlan | null = null;

    // Barge-in and Cancellation
    private abortController: AbortController | null = null;
    private currentResponseText: string = "";
    private interimStartTime: number = 0;
    private maxInterimWords: number = 0;

    constructor(localRtpPort: number = 0) {
        super();
        this.stt = new DeepgramSTTService();
        this.llm = new GroqLLMService();
        this.tts = new SarvamTTSService();
        this.bridge = new FreeSwitchAudioBridge(localRtpPort);

        this.setupPipeline();
    }

    /**
     * Abort current processing and save partial context
     */
    private abort(): void {
        if (this.abortController) {
            logger.info('Aborting current execution and saving partial context', {
                partialText: this.currentResponseText.substring(0, 30) + '...'
            });
            this.abortController.abort();
            this.abortController = null;
        }

        if (this.isProcessing && this.currentResponseText.trim().length > 0) {
            // Save what the AI *was* saying to history so it remembers the context
            this.llm.addToHistory('assistant', this.currentResponseText + " [interrupted]");
        }

        this.isProcessing = false;
        this.currentResponseText = "";
        this.tts.stop();
        this.bridge.clearOutboundQueue();
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
            // Reset barge-in tracking when a final transcript is received
            this.interimStartTime = 0;
            this.maxInterimWords = 0;

            if (this.startSpeakingPlan && this.startSpeakingPlan.smartEndpointing) {
                const words = transcript.trim().split(/\s+/);
                const lastWord = words[words.length - 1] || '';
                const hasPunctuation = /[?.!]$/.test(transcript.trim());
                const isNumber = /^\d+$/.test(lastWord.replace(/[?.!]/g, ''));

                let delay = this.startSpeakingPlan.onNoPunctuationSeconds;
                if (hasPunctuation) delay = this.startSpeakingPlan.onPunctuationSeconds;
                if (isNumber) delay = this.startSpeakingPlan.onNumberSeconds;

                logger.info(`Turn-taking delay: ${delay}s`, { transcript, hasPunctuation, isNumber });
                await new Promise(resolve => setTimeout(resolve, delay * 1000));
            }

            await this.handleTranscript(transcript);
        });

        // Handle interim results for barge-in detection
        this.stt.on('interim', (interim: string) => {
            const isPlaying = this.tts.playing || this.isProcessing;
            if (!isPlaying) return;

            if (!this.interimStartTime) this.interimStartTime = Date.now();

            const words = interim.trim().split(/\s+/).length;
            if (words > this.maxInterimWords) this.maxInterimWords = words;

            const duration = (Date.now() - this.interimStartTime) / 1000;

            const thresholdWords = this.stopSpeakingPlan?.interruptionThresholdWords ?? 2;
            const thresholdSeconds = this.stopSpeakingPlan?.interruptionThresholdSeconds ?? 0.5;

            if (this.maxInterimWords >= thresholdWords || duration >= thresholdSeconds) {
                logger.info('Barge-in detected - interrupting AI immediately', {
                    interim,
                    words: this.maxInterimWords,
                    duration: duration.toFixed(2),
                    thresholdWords,
                    thresholdSeconds
                });

                this.abort(); // Stop everything immediately
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
        if (this.startSpeakingPlan?.waitSeconds) {
            logger.info(`Waiting ${this.startSpeakingPlan.waitSeconds}s before greeting`);
            await new Promise(resolve => setTimeout(resolve, this.startSpeakingPlan!.waitSeconds * 1000));
        }
        await this.handleTranscript(null); // null triggers dynamic greeting from LLM
    }

    /**
     * Process transcript through LLM and TTS
     */
    private async handleTranscript(transcript: string | null): Promise<void> {
        // Cancel existing processing if a new turn starts
        this.abort();

        this.isProcessing = true;
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        this.currentResponseText = "";

        try {
            logger.info('Processing transcript', { transcript });
            this.emit('transcriptReceived', transcript);

            // Step 3: Get streaming response from LLM
            const llmStream = this.llm.streamResponse(transcript, signal);

            // Create a wrapper generator to capture currentResponseText
            const self = this;
            async function* llmCaptureStream() {
                for await (const chunk of llmStream) {
                    if (signal.aborted) return;
                    self.currentResponseText += chunk;
                    yield chunk;
                }
            }

            // Step 4: Convert LLM response to speech
            const ttsStream = this.tts.streamSpeech(llmCaptureStream(), signal);

            // Step 5: Stream audio chunks to FreeSWITCH via RTP
            for await (const audioChunk of ttsStream) {
                if (signal.aborted || !this.isProcessing) break;
                this.bridge.pushAudio(audioChunk);
                this.emit('audioChunk', audioChunk);
            }

            if (!signal.aborted) {
                logger.info('Response complete');
                this.emit('responseComplete');
            }

        } catch (error: any) {
            if (error.name === 'AbortError' || error.message?.includes('canceled')) {
                logger.info('Pipeline execution aborted');
            } else {
                this.handleError('Pipeline', error);
            }
        } finally {
            if (this.abortController?.signal === signal) {
                this.isProcessing = false;
                this.abortController = null;
            }
        }
    }

    /**
     * Start the conversation pipeline
     * @param callId - FreeSWITCH call UUID or unique call identifier
     * @param remoteRtpAddress - FreeSWITCH media IP (from SDP)
     * @param remoteRtpPort - FreeSWITCH media port (from SDP)
     * @param agentConfig - optional agent configuration
     */
    async start(
        callId: string,
        remoteRtpAddress?: string,
        remoteRtpPort?: number,
        agentConfig?: Partial<import('../agents/AgentService').AgentConfig>
    ): Promise<void> {
        try {
            logger.info('Starting conversation pipeline', { callId });
            this.callId = callId;

            if (agentConfig) {
                if (agentConfig.systemPrompt) this.llm.setSystemPrompt(agentConfig.systemPrompt);
                if (agentConfig.voiceId) this.tts.setSpeaker(agentConfig.voiceId);

                // New LLM settings
                if (agentConfig.llmModel) this.llm.setModel(agentConfig.llmModel);
                if (agentConfig.temperature !== undefined) this.llm.setTemperature(agentConfig.temperature);
                if (agentConfig.maxTokens !== undefined) this.llm.setMaxTokens(agentConfig.maxTokens);

                // New TTS settings
                if (agentConfig.ttsModel) this.tts.setModel(agentConfig.ttsModel);

                // Speaking plans
                if (agentConfig.startSpeakingPlan) this.startSpeakingPlan = agentConfig.startSpeakingPlan;
                if (agentConfig.stopSpeakingPlan) this.stopSpeakingPlan = agentConfig.stopSpeakingPlan;
            }

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

            this.isProcessing = false;
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
