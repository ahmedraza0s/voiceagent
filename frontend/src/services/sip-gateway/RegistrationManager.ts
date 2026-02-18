

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
        this.register();
    }

    stop() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    private register(authHeader?: string) {
        const request: any = {
            method: 'REGISTER',
            uri: `sip:${this.config.domain}`,
            headers: {
                to: { uri: `sip:${this.config.username}@${this.config.domain}` },
                from: { uri: `sip:${this.config.username}@${this.config.domain}`, params: { tag: uuidv4() } },
                'call-id': this.callId,
                cseq: { method: 'REGISTER', seq: 1 },
                contact: [{ uri: `sip:${this.config.username}@${this.config.domain}` }], // Need actual IP here
                expires: this.config.expires,
                'max-forwards': 70,
                via: [] // 'sip' lib fills this
            }
        };

        if (authHeader) {
            request.headers.authorization = authHeader;
            request.headers.cseq.seq++;
        }

        this.sipStack.send(request, (response: any) => {
            if (response.status >= 200 && response.status < 300) {
                logger.info(`Successfully Registered with ${this.config.domain}`);
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
