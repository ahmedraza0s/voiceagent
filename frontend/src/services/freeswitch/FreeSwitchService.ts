import { EventEmitter } from 'events';
import Srf from 'drachtio-srf';
import logger from '../../utils/logger';
import config from '../../config';

export interface CallInfo {
    callId: string;
    phoneNumber?: string;
    dialog?: any;
    startTime: Date;
}

/**
 * FreeSwitchService
 * Manages inbound and outbound SIP calls via FreeSWITCH using drachtio-srf (ESL).
 *
 * Events emitted:
 *   'connected'            - ESL connection to FreeSWITCH established
 *   'disconnected'         - ESL connection lost
 *   'inboundCall'          - { callId, dialog } - incoming call accepted
 *   'callConnected'        - { callId } - outbound call answered
 *   'callEnded'            - { callId }
 */
export class FreeSwitchService extends EventEmitter {
    private srf: any;
    private activeCalls: Map<string, CallInfo> = new Map();
    private isConnected: boolean = false;
    private lastErrorLogged: number = 0;
    private readonly ERROR_LOG_INTERVAL = 30000; // 30 seconds
    private hasLoggedError: boolean = false;

    constructor() {
        super();
        this.srf = new (Srf as any)();
        this.setupSrf();
    }

    private setupSrf(): void {
        // Note: drachtio-srf connects to a drachtio server, which then controls FreeSWITCH. 
        // If you intended to connect to FreeSWITCH ESL directly, use port 8021 with an ESL library.
        // Assuming drachtio is used here as per existing codebase.
        this.srf.connect({
            host: config.freeswitch.host,
            port: config.freeswitch.port,
            secret: config.freeswitch.password,
        });

        const hostport = `${config.freeswitch.host}:${config.freeswitch.port}`;
        this.srf.on('connect', (err: any, _hostport: string) => {
            if (err) {
                // Initial connection failed - this is expected if FreeSWITCH isn't started yet
                this.logErrorOnce(`📡 Waiting for FreeSWITCH/drachtio at ${hostport}...`, err);
                return;
            }
            logger.info(`✅ Connected to FreeSWITCH at ${hostport}`);
            this.isConnected = true;
            this.hasLoggedError = false;
            this.emit('connected');
        });

        this.srf.on('error', (err: any) => {
            // Only log as "lost" if we were actually connected before
            if (this.isConnected) {
                logger.error(`❌ FreeSWITCH connection lost at ${hostport}`, { error: err.message });
                this.isConnected = false;
                this.emit('disconnected');
            } else {
                // Otherwise, it's just a failed retry during startup phase
                this.logErrorOnce(`📡 Still waiting for FreeSWITCH/drachtio at ${hostport}...`, err);
            }
        });

        // Handle inbound SIP INVITEs
        this.srf.invite((req: any, res: any) => {
            this.handleInboundInvite(req, res);
        });
    }

    stop(): void {
        if (this.srf) {
            try {
                this.srf.disconnect();
                logger.info('FreeSwitchService stopped');
            } catch (err) {
                // Ignore disconnect errors
            }
        }
    }

    private logErrorOnce(message: string, err: any): void {
        const now = Date.now();
        if (!this.hasLoggedError || (now - this.lastErrorLogged > this.ERROR_LOG_INTERVAL)) {
            logger.error(message, { error: err.message });
            if (!this.hasLoggedError) {
                logger.warn('--- Subsequent connection errors will be suppressed for 30s ---');
            }
            this.hasLoggedError = true;
            this.lastErrorLogged = now;
        }
    }

    /**
     * Handle an inbound INVITE from FreeSWITCH
     */
    private async handleInboundInvite(req: any, res: any): Promise<void> {
        const callId = req.get('Call-ID') || `inbound-${Date.now()}`;
        logger.info('📞 Inbound call received', { callId, from: req.from });

        // Emit event to let the app handle answering (e.g. starting pipeline)
        this.emit('inboundCall', { callId, req, res });
    }

    /**
     * Answer an inbound call with specific local SDP
     */
    async answerInboundCall(req: any, res: any, localSdp: string): Promise<any> {
        const callId = req.get('Call-ID');
        logger.info('Answering inbound call', { callId });

        try {
            const dialog = await this.srf.createUAS(req, res, {
                localSdp: localSdp,
            });

            const callInfo: CallInfo = {
                callId,
                startTime: new Date(),
                dialog,
            };
            this.activeCalls.set(callId, callInfo);

            dialog.on('destroy', () => {
                logger.info('Inbound call ended', { callId });
                this.activeCalls.delete(callId);
                this.emit('callEnded', { callId });
            });

            logger.info('✅ Inbound call answered', { callId });
            return dialog;
        } catch (err: any) {
            logger.error('Failed to answer inbound call', { error: err.message, callId });
            throw err;
        }
    }

    /**
     * Make an outbound call via FreeSWITCH SIP gateway
     */
    async makeOutboundCall(phoneNumber: string, localSdp: string, providedCallId?: string): Promise<string> {
        if (!this.isConnected) {
            throw new Error('FreeSWITCH ESL not connected');
        }

        const callId = providedCallId || `call-${Date.now()}`;
        const sipUri = `sip:${phoneNumber}@${config.sip.domain}`;

        logger.info('📞 Initiating outbound call via FreeSWITCH', { phoneNumber, callId, sipUri });

        try {
            const uac = await this.srf.createUAC(
                sipUri,
                {
                    localSdp: localSdp,
                    headers: {
                        'From': `<sip:${config.sip.callerId || config.sip.username}@${config.sip.domain}>`,
                        'X-Call-ID': callId,
                    },
                    auth: {
                        username: config.sip.username,
                        password: config.sip.password,
                    },
                }
            );

            const callInfo: CallInfo = {
                callId,
                phoneNumber,
                dialog: uac,
                startTime: new Date(),
            };
            this.activeCalls.set(callId, callInfo);

            uac.on('destroy', () => {
                logger.info('Outbound call ended', { callId });
                this.activeCalls.delete(callId);
                this.emit('callEnded', { callId });
            });

            logger.info('✅ Outbound call connected', { callId, phoneNumber });
            this.emit('callConnected', { callId, phoneNumber, uac });

            return callId;
        } catch (err: any) {
            logger.error('Failed to make outbound call', { error: err.message, phoneNumber });
            throw err;
        }
    }

    /**
     * Parse SDP to extract remote IP and RTP port
     */
    static parseSdp(sdp: string): { address: string; port: number } {
        const lines = sdp.split('\r\n');
        let address = '';
        let port = 0;

        for (const line of lines) {
            if (line.startsWith('c=IN IP4 ')) {
                address = line.substring(9);
            } else if (line.startsWith('m=audio ')) {
                const parts = line.split(' ');
                port = parseInt(parts[1], 10);
            }
        }

        return { address, port };
    }

    /**
     * Generate a minimal SDP for PCMU 8kHz mono
     */
    static generateSdp(localIp: string, port: number): string {
        return [
            'v=0',
            `o=- ${Date.now()} ${Date.now()} IN IP4 ${localIp}`,
            's=-',
            `c=IN IP4 ${localIp}`,
            't=0 0',
            `m=audio ${port} RTP/AVP 0`,
            'a=rtpmap:0 PCMU/8000',
            'a=sendrecv',
            ''
        ].join('\r\n');
    }

    /**
     * Originate a call using FreeSWITCH ESL originate command (simpler approach)
     * This uses the ESL connection to send a raw originate command to FreeSWITCH.
     */
    async originate(phoneNumber: string): Promise<string> {
        if (!this.isConnected) {
            throw new Error('FreeSWITCH ESL not connected');
        }

        const callId = `call-${Date.now()}`;
        const gateway = config.freeswitch.sipGateway;
        const originateStr = `sofia/gateway/${gateway}/${phoneNumber}`;

        logger.info('📞 Originating call via FreeSWITCH ESL', { phoneNumber, callId, originateStr });

        return new Promise((resolve, reject) => {
            // Use drachtio ESL to send originate command
            this.srf.request(
                `originate ${originateStr} &echo()`,
                (err: any, evt: any) => {
                    if (err) {
                        logger.error('Originate failed', { error: err.message });
                        reject(err);
                        return;
                    }

                    const fsCallId = evt?.getHeader?.('variable_call_uuid') || callId;
                    logger.info('✅ Call originated', { fsCallId });

                    const callInfo: CallInfo = {
                        callId: fsCallId,
                        phoneNumber,
                        startTime: new Date(),
                    };
                    this.activeCalls.set(fsCallId, callInfo);
                    this.emit('callConnected', { callId: fsCallId, phoneNumber });
                    resolve(fsCallId);
                }
            );
        });
    }

    /**
     * Hang up an active call
     */
    async hangup(callId: string): Promise<void> {
        const callInfo = this.activeCalls.get(callId);
        if (!callInfo) {
            logger.warn('Hangup called for unknown call', { callId });
            return;
        }

        try {
            if (callInfo.dialog) {
                await callInfo.dialog.destroy();
            }
            this.activeCalls.delete(callId);
            this.emit('callEnded', { callId });
            logger.info('✅ Call hung up', { callId });
        } catch (err: any) {
            logger.error('Error hanging up call', { error: err.message, callId });
        }
    }

    /**
     * Get active call IDs
     */
    getActiveCalls(): string[] {
        return Array.from(this.activeCalls.keys());
    }

    /**
     * Get call info
     */
    getCallInfo(callId: string): CallInfo | undefined {
        return this.activeCalls.get(callId);
    }

    /**
     * Check if ESL is connected
     */
    get connected(): boolean {
        return this.isConnected;
    }
}
