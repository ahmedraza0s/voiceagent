
import { SipStack } from './SipStack';
import { MediaBridge } from './MediaBridge';
import { RegistrationManager } from './RegistrationManager';
import { CallSession } from './CallSession';
import logger from '../../utils/logger';


export class SIPGateway {
    private sipStack: SipStack;
    private mediaBridge: MediaBridge;
    private registrationManager: RegistrationManager;
    private activeCalls: Map<string, CallSession> = new Map();

    constructor() {
        // Initialize components
        this.sipStack = new SipStack({
            port: parseInt(process.env.SIP_PORT || '5060'),
            publicIp: process.env.SIP_PUBLIC_IP
        });

        this.mediaBridge = new MediaBridge(parseInt(process.env.RTP_PORT_RANGE_START || '10000'));

        this.registrationManager = new RegistrationManager(this.sipStack, {
            username: process.env.SIP_USERNAME || '',
            domain: process.env.SIP_DOMAIN || '',
            password: process.env.SIP_PASSWORD || '',
            proxy: process.env.SIP_INBOUND_PROXY
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
    }

    private handleRequest(request: any) {
        switch (request.method) {
            case 'INVITE':
                this.handleInvite(request);
                break;
            case 'BYE':
                this.handleBye(request);
                break;
            // ACK, CANCEL, etc. would be handled here
        }
    }

    private handleInvite(request: any) {
        const callId = request.headers['call-id'];
        const session = new CallSession(this.sipStack, this.mediaBridge, callId);
        this.activeCalls.set(callId, session);
        session.handleInvite(request);
    }

    private handleBye(request: any) {
        const callId = request.headers['call-id'];
        const session = this.activeCalls.get(callId);
        if (session) {
            session.end();
            this.activeCalls.delete(callId);
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
