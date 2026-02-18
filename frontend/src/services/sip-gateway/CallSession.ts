
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
        if (request.content) {
            this.remoteSdp = sdpTransform.parse(request.content);
            const audioMedia = this.remoteSdp.media.find((m: any) => m.type === 'audio');
            if (audioMedia) {
                logger.info(`Remote Audio: ${audioMedia.port} (${audioMedia.protocol})`);
                await this.mediaBridge.bridgeToRoom('inbound-room', audioMedia.port, request.headers.contact[0].uri); // Simplified contact extraction
            }
        }

        // 3. Send Ringing
        const ringing = {
            status: 180,
            reason: 'Ringing',
            headers: trying.headers
        };
        this.sipStack.send(ringing);

        // 4. Send OK (Answer)
        // Need to generate Local SDP here pointing to our MediaBridge IP/Port
        const answerSdp = 'v=0\r\n...'; // Placeholder

        const ok = {
            status: 200,
            reason: 'OK',
            headers: {
                ...trying.headers,
                'content-type': 'application/sdp',
                contact: [{ uri: `sip:me@myserver.com` }] // Need actual IP/Contact logic
            },
            content: answerSdp
        };
        this.sipStack.send(ok);

        logger.info(`Call ${this.callId} answered`);
    }

    end() {
        // Send BYE if active
    }
}
