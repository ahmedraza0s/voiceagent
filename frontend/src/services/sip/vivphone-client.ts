import { EventEmitter } from 'events';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import * as os from 'os';
import logger from '../../utils/logger';
import config from '../../config';

/**
 * Native SIP Client for VivPhone
 * Makes actual SIP calls using UDP transport
 */
export class VivPhoneSIPClient extends EventEmitter {
    private socket: dgram.Socket | null = null;
    private activeCalls: Map<string, any> = new Map();
    private callSequence = 1;
    private localIp = '0.0.0.0'; // Will be set automatically
    private signalingPort = 0;
    private rtpBridge: any = null;

    constructor() {
        super();
    }

    /**
     * Make a SIP call to a phone number using VivPhone
     */
    async makeCall(phoneNumber: string): Promise<string> {
        const callId = `${Date.now()}@${config.sip.domain}`;

        logger.info('🚀 Initiating VivPhone SIP call', {
            phoneNumber,
            callId,
            server: config.sip.domain,
        });

        try {
            // Create UDP socket for SIP signaling
            this.socket = dgram.createSocket('udp4');

            // Set up socket listeners
            this.socket.on('message', (msg, rinfo) => {
                this.handleSIPResponse(msg.toString(), callId, phoneNumber, rinfo);
            });

            // Bind to an available local port
            await new Promise<void>((resolve) => {
                this.socket!.bind(0, () => {
                    const addr = this.socket!.address();
                    this.signalingPort = addr.port;
                    resolve();
                });
            });
            logger.info('📡 SIP Signaling socket bound', { port: this.signalingPort });

            this.socket.on('error', (err) => {
                logger.error('UDP socket error', { error: err.message });
            });

            // Detect local IP (prefer non-internal IPv4)
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]!) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        this.localIp = iface.address;
                        break;
                    }
                }
                if (this.localIp !== '0.0.0.0') break;
            }
            logger.info('📡 Detected local IP', { ip: this.localIp });

            // Start RTP Bridge to get local port
            const { RTPBridge } = require('./rtp-bridge');
            this.rtpBridge = new RTPBridge();
            const rtpPort = await this.rtpBridge.start();

            // Forward audio from RTP to subscribers
            this.rtpBridge.on('audio', (pcm16: Buffer) => {
                this.emit('audio', { callId, pcm16 });
            });

            // Generate tags for the call
            const fromTag = Math.floor(Math.random() * 1000000000).toString();

            // Build SIP INVITE message with SDP
            const sipInvite = this.buildSIPInvite(phoneNumber, callId, fromTag, undefined, rtpPort);

            logger.info('📤 Sending SIP INVITE', {
                to: phoneNumber,
                server: config.sip.domain,
                port: config.sip.port,
            });

            // Send INVITE to VivPhone server
            const serverIp = '51.195.161.145'; // VivPhone IP
            const buffer = Buffer.from(sipInvite);

            this.socket.send(buffer, 0, buffer.length, config.sip.port, serverIp, (err) => {
                if (err) {
                    logger.error('Failed to send INVITE', { error: err.message });
                    throw err;
                }
                logger.info('✅ SIP INVITE sent successfully');
            });

            this.activeCalls.set(callId, {
                phoneNumber,
                status: 'calling',
                socket: this.socket,
                cseq: this.callSequence, // Match the CSeq used in buildSIPInvite
                fromTag: fromTag,
                rtpBridge: this.rtpBridge,
                authAttempts: 0,
            });

            return callId;

        } catch (error: any) {
            logger.error('❌ SIP call failed', {
                error: error.message,
                phoneNumber,
            });
            throw error;
        }
    }

    /**
     * Build SIP INVITE message
     */
    private buildSIPInvite(phoneNumber: string, callId: string, fromTag: string, authHeader?: string, rtpPort?: number): string {
        const fromUri = `sip:${config.sip.username}@${config.sip.domain}`;
        const toUri = `sip:${phoneNumber}@${config.sip.domain}`;
        const branch = `z9hG4bK${Math.floor(Math.random() * 1000000000)}`;
        const via = `SIP/2.0/UDP ${this.localIp}:${this.signalingPort};branch=${branch}`;
        const cseq = `${this.callSequence} INVITE`;

        // Build SDP payload
        let sdp = '';
        if (rtpPort) {
            sdp = [
                'v=0',
                `o=- ${Date.now()} ${Date.now()} IN IP4 ${this.localIp}`,
                's=AI-Voice-Agent',
                `c=IN IP4 ${this.localIp}`,
                't=0 0',
                `m=audio ${rtpPort} RTP/AVP 0`,
                'a=rtpmap:0 PCMU/8000',
                'a=sendrecv',
            ].join('\r\n') + '\r\n';
        }

        const headers = [
            `INVITE ${toUri} SIP/2.0`,
            `Via: ${via}`,
            `Max-Forwards: 70`,
            `From: <${fromUri}>;tag=${fromTag}`,
            `To: <${toUri}>`,
            `Call-ID: ${callId}`,
            `CSeq: ${cseq}`,
            `Contact: <sip:${config.sip.username}@${this.localIp}:${this.signalingPort}>`,
            `User-Agent: AI-Voice-Agent/1.0`,
            `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS`,
        ];

        if (authHeader) {
            headers.push(authHeader);
        }

        if (sdp) {
            headers.push(`Content-Type: application/sdp`);
            headers.push(`Content-Length: ${sdp.length}`);
            headers.push('', sdp);
        } else {
            headers.push(`Content-Length: 0`);
            headers.push('', '');
        }

        return headers.join('\r\n');
    }

    /**
     * Handle SIP responses from server
     */
    private handleSIPResponse(response: string, callId: string, phoneNumber: string, rinfo: any): void {
        const statusCodeMatch = response.match(/SIP\/2\.0 (\d+)/);
        if (!statusCodeMatch) return;

        const statusCode = parseInt(statusCodeMatch[1]);
        const call = this.activeCalls.get(callId);

        logger.info('📩 SIP Response', {
            code: statusCode,
            callId,
            from: `${rinfo.address}:${rinfo.port}`
        });

        switch (true) {
            case statusCode === 100:
                logger.info('⏳ Trying...');
                break;
            case statusCode === 180:
                logger.info('🔔 Ringing...');
                // Try to parse SDP from 180 just in case
                this.handleSDPResponse(response, callId);
                this.emit('ringing', { callId });
                break;
            case statusCode === 183:
                logger.info('🔊 Session Progress (Early Media)');
                this.handleSDPResponse(response, callId);
                break;
            case statusCode === 200:
                logger.info('✅ Connected!');
                this.handleSDPResponse(response, callId);
                this.emit('connected', { callId });
                this.sendACK(callId, response, rinfo);
                break;
            case statusCode === 401 || statusCode === 407:
                // Send ACK for the 401/407 response (required by SIP standard)
                this.sendACK(callId, response, rinfo);

                // Extract CSeq to identify which request failed
                const cseqMatch = response.match(/CSeq: (\d+)/i);
                const respCSeq = cseqMatch ? parseInt(cseqMatch[1]) : 0;

                if (call && call.authAttempts < 3 && (!call.lastAuthCSeq || respCSeq > call.lastAuthCSeq)) {
                    call.authAttempts++;
                    call.lastAuthCSeq = respCSeq;
                    this.handleAuthentication(response, callId, phoneNumber);
                } else {
                    logger.info('ℹ️ Ignoring duplicate or too many auth challenges', {
                        statusCode,
                        respCSeq,
                        lastAuthCSeq: call?.lastAuthCSeq
                    });
                }
                break;
            default:
                if (statusCode >= 300) {
                    logger.error('❌ Call failed/rejected', { statusCode });
                    this.emit('failed', { callId, statusCode });
                    // Clean up
                    if (this.activeCalls.has(callId)) {
                        this.endCall(callId);
                    }
                }
                break;
        }
    }

    /**
     * Parse SDP from response and configure RTP bridge
     */
    private handleSDPResponse(response: string, callId: string): void {
        const call = this.activeCalls.get(callId);
        if (!call || !call.rtpBridge) return;

        // Find connection IP
        const connectionMatch = response.match(/c=IN IP4 ([^\s\r\n]+)/);
        const remoteIp = connectionMatch ? connectionMatch[1] : '51.195.161.145'; // Fallback to server IP

        // Find media port
        const mediaMatch = response.match(/m=audio (\d+) RTP\/AVP/);
        const remotePort = mediaMatch ? parseInt(mediaMatch[1], 10) : null;

        if (remotePort) {
            logger.info('🎯 Remote RTP destination discovered', { ip: remoteIp, port: remotePort });
            call.rtpBridge.setRemoteDestination(remoteIp, remotePort);
        } else {
            logger.warn('⚠️ Could not find remote RTP port in SDP response');
        }
    }

    /**
     * Send audio to current active call
     */
    sendAudio(pcm16: Buffer): void {
        // Send to all active calls for now (simplicity)
        for (const call of this.activeCalls.values()) {
            if (call.rtpBridge) {
                call.rtpBridge.sendAudio(pcm16);
            }
        }
    }

    /**
     * Send ACK after 200 OK
     */
    private sendACK(callId: string, response: string, rinfo: any): void {
        const call = this.activeCalls.get(callId);
        if (!call) return;

        const fromUri = `sip:${config.sip.username}@${config.sip.domain}`;
        const toUri = `sip:${call.phoneNumber}@${config.sip.domain}`;

        // Extract To tag from response
        const toTagMatch = response.match(/To:.*tag=([^\s;>]+)/i);
        const toTag = toTagMatch ? `;tag=${toTagMatch[1]}` : '';

        const ack = [
            `ACK ${toUri} SIP/2.0`,
            `Via: SIP/2.0/UDP ${this.localIp}:${config.sip.port};branch=z9hG4bK${Math.floor(Math.random() * 1000000)}`,
            `From: <${fromUri}>;tag=${call.fromTag}`,
            `To: <${toUri}>${toTag}`,
            `Call-ID: ${callId}`,
            `CSeq: ${call.cseq} ACK`, // Matches original INVITE CSeq
            `Max-Forwards: 70`,
            `Content-Length: 0`,
            '',
            '',
        ].join('\r\n');

        const buffer = Buffer.from(ack);
        if (call.socket) {
            call.socket.send(buffer, 0, buffer.length, rinfo.port, rinfo.address, (err: Error | null) => {
                if (err) logger.error('Error sending ACK', { error: err.message });
                else logger.info('✅ ACK sent');
            });
        }
    }

    /**
     * Handle authentication challenge
     */
    private handleAuthentication(response: string, callId: string, phoneNumber: string): void {
        const call = this.activeCalls.get(callId);
        if (!call) return;

        logger.info('🔐 Handling SIP authentication...');

        // Extract authentication details
        const authMatch = response.match(/WWW-Authenticate: Digest (.+)/i) ||
            response.match(/Proxy-Authenticate: Digest (.+)/i);

        if (!authMatch) {
            logger.error('No authentication header found');
            return;
        }

        const authParams = this.parseAuthHeader(authMatch[1]);

        logger.info('Auth parameters:', {
            realm: authParams.realm,
            nonce: authParams.nonce,
            qop: authParams.qop,
        });

        // Calculate digest response
        const username = config.sip.username;
        const password = config.sip.password;
        const realm = authParams.realm || config.sip.domain;
        const nonce = authParams.nonce || '';
        const uri = `sip:${phoneNumber}@${config.sip.domain}`;
        const method = 'INVITE';

        const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
        const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');

        let responseHash: string;
        let authHeader: string;

        if (authParams.qop === 'auth') {
            const nc = '00000001';
            const cnonce = crypto.randomBytes(8).toString('hex');
            responseHash = crypto.createHash('md5')
                .update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
                .digest('hex');
            authHeader = `Authorization: Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}", qop=auth, nc=${nc}, cnonce="${cnonce}", algorithm=MD5`;
        } else {
            responseHash = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
            authHeader = `Authorization: Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}", algorithm=MD5`;
        }

        logger.info('🔑 Calculated digest auth', {
            username,
            realm,
            uri,
            mode: authParams.qop || 'basic'
        });

        // Resend INVITE with authentication (INCREMENT CSeq)
        this.callSequence++;
        call.cseq = this.callSequence;

        // Ensure we use the SAME branch ID logic or a new one? 
        // Standards say NEW branch for NEW request (different CSeq).
        const authenticatedInvite = this.buildSIPInvite(phoneNumber, callId, call.fromTag, authHeader, call.rtpBridge?.port);
        const buffer = Buffer.from(authenticatedInvite);

        if (call.socket) {
            call.socket.send(buffer, 0, buffer.length, config.sip.port, '51.195.161.145', (err: Error | null) => {
                if (err) {
                    logger.error('Failed to send authenticated INVITE', { error: err.message });
                } else {
                    logger.info('✅ Authenticated INVITE sent');
                }
            });
        }
    }

    /**
     * Parse authentication header parameters
     */
    private parseAuthHeader(header: string): any {
        const params: any = {};
        const regex = /(\w+)="?([^",]+)"?/g;
        let match;

        while ((match = regex.exec(header)) !== null) {
            params[match[1]] = match[2];
        }

        return params;
    }

    /**
     * Stop outgoing audio (for barge-in)
     */
    stopAudio(): void {
        // This method needs to be implemented in the context of a specific call.
        // For now, we'll assume it's called on the current active call if there's only one,
        // or it needs a callId parameter.
        // Given the current `sendAudio` sends to all, this might need refinement.
        // For a single call scenario, we might have a `currentCall` property.
        // If `this.rtpBridge` refers to a single bridge for a single call, then this is fine.
        // If there are multiple calls, this method needs to be associated with a specific call.
        // Assuming `this.rtpBridge` is for the *current* call being managed by this instance.
        // If this class manages multiple calls, this method should take a `callId`.
        // Let's assume for now `this.rtpBridge` is the one associated with the call we want to stop audio for.
        // If this is a `SipClient` class that manages multiple calls, this method should be on the `Call` object or take `callId`.
        // Given the context of `sendAudio` iterating `this.activeCalls.values()`,
        // this `stopAudio` method should probably be on the `Call` object itself, or take `callId`.
        // For now, I'll implement it as if it's stopping audio for *all* active calls, similar to `sendAudio`.
        for (const call of this.activeCalls.values()) {
            if (call.rtpBridge) {
                call.rtpBridge.clearAudioBuffer();
            }
        }
    }

    /**
     * End a call
     */
    async endCall(callId: string): Promise<void> {
        const call = this.activeCalls.get(callId);
        if (!call) return;

        logger.info('📴 Ending call', { callId });

        try {
            // Send BYE message to properly terminate the call
            const fromUri = `sip:${config.sip.username}@${config.sip.domain}`;
            const toUri = `sip:${call.phoneNumber}@${config.sip.domain}`;

            const bye = [
                `BYE ${toUri} SIP/2.0`,
                `Via: SIP/2.0/UDP ${this.localIp}:${config.sip.port};branch=z9hG4bK${Date.now()}`,
                `From: <${fromUri}>;tag=${call.fromTag || Date.now()}`,
                `To: <${toUri}>`,
                `Call-ID: ${callId}`,
                `CSeq: ${this.callSequence++} BYE`,
                `Content-Length: 0`,
                '',
                '',
            ].join('\r\n');

            if (call.socket) {
                const buffer = Buffer.from(bye);
                call.socket.send(buffer, 0, buffer.length, config.sip.port, '51.195.161.145', (err: Error | null) => {
                    if (!err) {
                        logger.info('✅ BYE message sent to terminate call');
                    }
                });

                // Close socket after a short delay
                setTimeout(() => {
                    if (call.rtpBridge) {
                        call.rtpBridge.stop();
                    }
                    if (call.socket) {
                        call.socket.close();
                    }
                }, 500);
            }
        } catch (error: any) {
            logger.error('Error sending BYE', { error: error.message });
        }

        this.activeCalls.delete(callId);
        this.emit('ended', { callId });
    }
}
