
import { SipStack } from './SipStack';
import { MediaBridge } from './MediaBridge';
import logger from '../../utils/logger';
// import { sdp as sdpTransform } from 'sdp-transform'; // Need to install types or use require
const sdpTransform = require('sdp-transform');

export class CallSession {
    private sipStack: SipStack;
    private mediaBridge: MediaBridge;
    private callId: string;
    private remoteSdp: any;


    constructor(sipStack: SipStack, mediaBridge: MediaBridge, callId: string) {
        this.sipStack = sipStack;
        this.mediaBridge = mediaBridge;
        this.callId = callId;
    }

    async handleInvite(request: any) {
        logger.info(`Handling INVITE for call ${this.callId}`);

        // 1. Send Trying
        const trying = {
            status: 100,
            reason: 'Trying',
            headers: {
                to: request.headers.to,
                from: request.headers.from,
                'call-id': request.headers['call-id'],
                cseq: request.headers.cseq,
                via: request.headers.via
            }
        };
        this.sipStack.send(trying);

        // 2. Parsed Remote SDP to get audio port/ip
        let remotePort = 0;
        let remoteAddress = '';
        const roomName = `room-${this.callId.substring(0, 8)}`;

        if (request.content) {
            try {
                this.remoteSdp = sdpTransform.parse(request.content);
                const audioMedia = this.remoteSdp.media.find((m: any) => m.type === 'audio');
                if (audioMedia) {
                    remotePort = audioMedia.port;
                    remoteAddress = this.remoteSdp.connection?.ip || this.remoteSdp.origin?.address;
                    logger.info(`Remote Audio: ${remoteAddress}:${remotePort} (${audioMedia.protocol})`);

                    // Trigger bridge with unique room name
                    await this.mediaBridge.bridgeToRoom(roomName, remotePort, remoteAddress);
                }
            } catch (sdpError) {
                logger.error('Failed to parse remote SDP', { error: sdpError });
            }
        }

        // 3. Send Ringing
        const ringing = {
            status: 180,
            reason: 'Ringing',
            headers: trying.headers
        };
        this.sipStack.send(ringing);

        // 4. Generate Local SDP and Send OK (Answer)
        const localIp = this.sipStack.config.publicIp || '127.0.0.1';
        const localMediaPort = (this.mediaBridge as any).port; // Internal access for signaling

        const answerSdp = [
            'v=0',
            `o=- ${Math.floor(Math.random() * 1000000)} ${Math.floor(Math.random() * 1000000)} IN IP4 ${localIp}`,
            's=-',
            `c=IN IP4 ${localIp}`,
            't=0 0',
            `m=audio ${localMediaPort} RTP/AVP 0 101`,
            'a=rtpmap:0 PCMU/8000',
            'a=rtpmap:101 telephone-event/8000',
            'a=fmtp:101 0-15',
            'a=sendrecv',
            ''
        ].join('\r\n');

        const ok = {
            status: 200,
            reason: 'OK',
            headers: {
                ...trying.headers,
                'content-type': 'application/sdp',
                contact: [{ uri: `sip:${this.sipStack.config.publicIp || '127.0.0.1'}:${this.sipStack.config.port}` }]
            },
            content: answerSdp
        };
        this.sipStack.send(ok, (res: any) => {
            logger.debug(`Answer response: ${res.status}`);
        });

        logger.info(`Call ${this.callId} answered. Room: ${roomName}`);
    }

    end() {
        // Send BYE if active
    }
}
