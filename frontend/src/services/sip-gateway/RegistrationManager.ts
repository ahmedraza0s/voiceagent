

import { EventEmitter } from 'events';
import { SipStack } from './SipStack';
import logger from '../../utils/logger';
const { v4: uuidv4 } = require('uuid');

interface RegistrationConfig {
    username: string;
    domain: string;
    password?: string;
    proxy?: string;
    expires?: number;
}

export class RegistrationManager extends EventEmitter {
    private sipStack: SipStack;
    private config: RegistrationConfig;
    private refreshTimer: NodeJS.Timeout | null = null;
    private callId: string;
    private detectedPort: number | null = null;
    private detectedIp: string | null = null;

    constructor(sipStack: SipStack, config: RegistrationConfig) {
        super();
        this.sipStack = sipStack;
        this.config = {
            expires: 3600,
            ...config
        };
        this.callId = uuidv4();
    }

    start() {
        // Option to clear stale registrations first?
        // this.unregisterAll(); 
        this.register();
    }

    unregisterAll() {
        logger.info('Clearing all active SIP registrations for this account');
        const request: any = {
            method: 'REGISTER',
            uri: `sip:${this.config.domain}`,
            headers: {
                to: { uri: `sip:${this.config.username}@${this.config.domain}` },
                from: { uri: `sip:${this.config.username}@${this.config.domain}`, params: { tag: uuidv4() } },
                'call-id': uuidv4(),
                cseq: { method: 'REGISTER', seq: 1 },
                contact: [{ uri: '*' }],
                expires: 0,
                'max-forwards': 70,
                via: []
            }
        };

        this.sipStack.send(request, (response: any) => {
            logger.info('Unregister response received', { status: response.status });
        });
    }

    stop() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    private register(authHeader?: string) {
        const port = this.detectedPort || this.sipStack.config.port;
        const ip = this.detectedIp || this.sipStack.config.publicIp || '127.0.0.1';

        const request: any = {
            method: 'REGISTER',
            uri: `sip:${this.config.domain}`,
            headers: {
                to: { uri: `sip:${this.config.username}@${this.config.domain}` },
                from: { uri: `sip:${this.config.username}@${this.config.domain}`, params: { tag: uuidv4() } },
                'call-id': this.callId,
                cseq: { method: 'REGISTER', seq: authHeader ? 2 : 1 },
                contact: [{ uri: `sip:${this.config.username}@${ip}:${port}` }],
                expires: this.config.expires,
                'max-forwards': 70,
                via: [] // 'sip' lib fills this
            }
        };

        logger.debug('Sending Registration Request', {
            method: request.method,
            uri: request.uri,
            contact: request.headers.contact[0].uri,
            callId: request.headers['call-id']
        });

        if (authHeader) {
            request.headers.authorization = authHeader;
            request.headers.cseq.seq++;
        }

        this.sipStack.send(request, (response: any) => {
            logger.debug('Registration Response Received', {
                status: response.status,
                reason: response.reason,
                headers: response.headers
            });

            if (response.status >= 200 && response.status < 300) {
                logger.info(`Successfully Registered with ${this.config.domain}`);

                // Inspect Via header for NAT info
                const via = Array.isArray(response.headers.via) ? response.headers.via[0] : response.headers.via;
                if (via && via.params) {
                    const received = via.params.received;
                    const rport = via.params.rport;
                    if (received || rport) {
                        logger.info(`NAT Detected: provider sees us as ${received || 'unknown'}:${rport || 'unknown'}`);
                        // If the port they see is different from what we think, we might need to re-register
                        if (rport && (parseInt(rport) !== (this.detectedPort || this.sipStack.config.port))) {
                            logger.warn(`Port mismatch! Provider sees ${rport}, we reported ${this.detectedPort || this.sipStack.config.port}. Attempting to fix...`);
                            this.detectedPort = parseInt(rport);
                            this.detectedIp = received;

                            // Re-register with correct info after a small delay
                            setTimeout(() => {
                                this.unregisterAll();
                                this.register();
                            }, 2000);
                            return;
                        }
                    }
                }

                this.scheduleRefresh();
                this.emit('registered');
            } else if (response.status === 401 && !authHeader) {
                // Challenge
                const wwwAuth = response.headers['www-authenticate'];
                if (!wwwAuth) {
                    logger.error('Received 401 without WWW-Authenticate header');
                    return;
                }

                const { calculateDigest, parseChallenge } = require('../../utils/digest-auth');
                let challenge: any;

                if (Array.isArray(wwwAuth)) {
                    // sip.js parses multi-headers into an array of objects
                    challenge = { ...wwwAuth[0] };
                    // sip.js preserves quotes, so we strip them here
                    Object.keys(challenge).forEach(key => {
                        if (typeof challenge[key] === 'string') {
                            challenge[key] = challenge[key].replace(/^"|"$/g, '');
                        }
                    });
                } else if (typeof wwwAuth === 'string') {
                    challenge = parseChallenge(wwwAuth);
                } else {
                    challenge = { ...wwwAuth };
                    Object.keys(challenge).forEach(key => {
                        if (typeof challenge[key] === 'string') {
                            challenge[key] = challenge[key].replace(/^"|"$/g, '');
                        }
                    });
                }

                const nc = '00000001';
                const cnonce = Math.random().toString(36).substring(7);
                const uri = `sip:${this.config.domain}`;
                const method = 'REGISTER';

                const responseDigest = calculateDigest(
                    method,
                    uri,
                    this.config.username,
                    this.config.password || '',
                    challenge.realm,
                    challenge.nonce,
                    challenge.qop,
                    cnonce,
                    nc
                );

                let authHeaderString = `Digest username="${this.config.username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${responseDigest}", algorithm="MD5"`;

                if (challenge.qop) {
                    authHeaderString += `, qop=${challenge.qop}, nc=${nc}, cnonce="${cnonce}"`;
                }

                if (challenge.opaque) {
                    authHeaderString += `, opaque="${challenge.opaque}"`;
                }

                // Re-send with auth
                this.register(authHeaderString); // Recursive call with auth
                logger.error(`Registration Failed: ${response.status} ${response.reason}`);
                this.emit('registrationFailed', response);
            }
        });
    }

    private scheduleRefresh() {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        const timeout = (this.config.expires || 3600) * 1000 * 0.9; // Refresh at 90% of expiry
        this.refreshTimer = setTimeout(() => this.register(), timeout);
    }
}
