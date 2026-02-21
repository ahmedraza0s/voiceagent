import { EventEmitter } from 'events';
import { SipStack } from './SipStack';
import { MediaBridge } from './MediaBridge';
import { RegistrationManager } from './RegistrationManager';
import { CallSession } from './CallSession';
import { ConversationPipeline } from '../conversation/pipeline';
import logger from '../../utils/logger';


export class SIPGateway extends EventEmitter {
    private sipStack: SipStack;
    private mediaBridge: MediaBridge;
    private registrationManager: RegistrationManager;
    private activeCalls: Map<string, CallSession> = new Map();
    private activePipelines: Map<string, ConversationPipeline> = new Map();

    constructor() {
        super();
        // Initialize components
        this.sipStack = new SipStack({
            port: parseInt(process.env.SIP_PORT || '5060'),
            publicIp: process.env.SIP_PUBLIC_IP
        });

        this.mediaBridge = new MediaBridge(0);

        this.registrationManager = new RegistrationManager(this.sipStack, {
            username: process.env.SIP_USERNAME || '',
            domain: process.env.SIP_DOMAIN || '',
            password: process.env.SIP_PASSWORD || '',
            proxy: process.env.SIP_INBOUND_PROXY
        });

        // Wire MediaBridge audio events directly to pipelines
        this.mediaBridge.on('audio', (pcm16: Buffer) => {
            for (const pipeline of this.activePipelines.values()) {
                // Forward caller audio to all active pipelines
                // In practice there's usually one active call at a time
                (pipeline as any).stt?.sendAudio?.(pcm16);
            }
        });

        // Setup Event Listeners
        this.setupEventListeners();
    }

    private setupEventListeners() {
        this.sipStack.on('request', (request) => this.handleRequest(request));

        this.registrationManager.on('registered', () => {
            logger.info('SIP Gateway is Online and Registered');
        });

        this.registrationManager.on('registrationFailed', () => {
            logger.error('SIP Gateway failed to register');
        });
    }

    async start() {
        logger.info('Starting SIP Gateway...');
        try {
            this.sipStack.start();
            await this.mediaBridge.start();

            // Only register if configured
            if (process.env.SIP_USERNAME && process.env.SIP_DOMAIN) {
                this.registrationManager.start();
            } else {
                logger.warn('SIP Credentials missing, skipping registration');
            }
        } catch (error: any) {
            logger.error(`Failed to start SIP Gateway: ${error.message}`);
        }
    }

    stop() {
        this.registrationManager.stop();
        this.sipStack.stop();
        this.mediaBridge.stop();
        for (const pipeline of this.activePipelines.values()) {
            pipeline.stop();
        }
    }

    private handleRequest(request: any) {
        switch (request.method) {
            case 'INVITE':
                this.handleInvite(request);
                break;
            case 'BYE':
                this.handleBye(request);
                break;
        }
    }

    private async handleInvite(request: any) {
        const callId = request.headers['call-id'];
        logger.info(`Received inbound INVITE: ${callId}`);

        const session = new CallSession(this.sipStack, this.mediaBridge, callId);
        this.activeCalls.set(callId, session);

        // Start a conversation pipeline for this call
        const pipeline = new ConversationPipeline();
        this.activePipelines.set(callId, pipeline);

        // Wire pipeline audio output back to caller via MediaBridge
        pipeline.on('audioChunk', (pcm16: Buffer) => {
            this.mediaBridge.sendAudio(pcm16);
        });

        pipeline.on('stopped', () => {
            this.activePipelines.delete(callId);
        });

        // Emit inbound call event for the main app to handle
        this.emit('inboundCall', { callId, request, session });

        // Handle the SIP INVITE (sends 100 Trying, 180 Ringing, 200 OK with SDP)
        await session.handleInvite(request);

        // Start the pipeline after SDP is negotiated
        const remoteAddress = session.remoteRtpAddress;
        const remotePort = session.remoteRtpPort;

        try {
            await pipeline.start(callId, remoteAddress, remotePort);
            logger.info('📞 Inbound call pipeline started, triggering greeting');
            await pipeline.sayHello();
        } catch (err: any) {
            logger.error('Failed to start pipeline for inbound call', { error: err.message, callId });
        }
    }

    private handleBye(request: any) {
        const callId = request.headers['call-id'];
        const session = this.activeCalls.get(callId);
        if (session) {
            session.end();
            this.activeCalls.delete(callId);

            // Stop pipeline
            const pipeline = this.activePipelines.get(callId);
            if (pipeline) {
                pipeline.stop();
                this.activePipelines.delete(callId);
            }

            logger.info(`Call ${callId} ended`);
            this.sipStack.send({
                status: 200,
                reason: 'OK',
                headers: {
                    to: request.headers.to,
                    from: request.headers.from,
                    'call-id': callId,
                    cseq: request.headers.cseq,
                    via: request.headers.via
                }
            });
        } else {
            logger.warn(`Received BYE for unknown call ${callId}`);
            this.sipStack.send({
                status: 481,
                reason: 'Call/Transaction Does Not Exist',
                headers: {
                    to: request.headers.to,
                    from: request.headers.from,
                    'call-id': callId,
                    cseq: request.headers.cseq,
                    via: request.headers.via
                }
            });
        }
    }
}
