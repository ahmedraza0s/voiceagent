import { EventEmitter } from 'events';
import logger from '../../utils/logger';
import config from '../../config';

/**
 * Direct SIP Dialer using VivPhone
 * Makes actual SIP calls using native UDP transport
 */
export class DirectSIPDialer extends EventEmitter {
    private activeCalls: Map<string, any> = new Map();

    constructor() {
        super();
    }

    /**
     * Make a direct SIP call to VivPhone
     * @param phoneNumber - Phone number to call (E.164 format)
     * @returns Call ID
     */
    async makeCall(phoneNumber: string): Promise<string> {
        try {
            const callId = `call-${Date.now()}-${Math.random().toString(36).substring(7)}`;

            logger.info('🔥 Making DIRECT VivPhone SIP call', {
                phoneNumber,
                callId,
                sipServer: config.sip.domain,
            });

            // Use native VivPhone SIP client
            const { VivPhoneSIPClient } = require('./vivphone-client');
            const sipClient = new VivPhoneSIPClient();

            // Set up event handlers
            sipClient.on('ringing', () => {
                logger.info('📞 Phone is ringing...');
                this.emit('callRinging', { callId, phoneNumber });
            });

            sipClient.on('connected', () => {
                logger.info('✅ Call connected!');
                this.emit('callConnected', { callId, phoneNumber });
            });

            sipClient.on('failed', (data: any) => {
                logger.error('❌ Call failed', data);
                this.emit('callFailed', { callId, phoneNumber, ...data });
            });

            sipClient.on('ended', () => {
                logger.info('📴 Call ended');
                this.emit('callEnded', { callId, phoneNumber });
            });

            sipClient.on('audio', (data: any) => {
                // Forward audio to subscribers, but use our internal callId
                this.emit('audio', { callId, pcm16: data.pcm16 });
            });

            // Make the call
            const sipCallId = await sipClient.makeCall(phoneNumber);

            this.activeCalls.set(callId, {
                sipCallId,
                sipClient,
                phoneNumber,
            });

            logger.info('✅ VivPhone SIP call initiated', {
                callId,
                sipCallId,
                phoneNumber,
            });

            this.emit('callStarted', { callId, phoneNumber });

            return callId;

        } catch (error: any) {
            logger.error('❌ Direct SIP call failed', {
                error: error.message,
                phoneNumber,
            });
            throw error;
        }
    }

    /**
     * End an active call
     */
    async endCall(callId: string): Promise<void> {
        const call = this.activeCalls.get(callId);

        if (!call) {
            logger.warn('Call not found', { callId });
            return;
        }

        try {
            if (call.sipClient) {
                await call.sipClient.endCall(call.sipCallId);
            }

            this.activeCalls.delete(callId);
            logger.info('Call ended', { callId });

        } catch (error: any) {
            logger.error('Error ending call', { error: error.message, callId });
        }
    }

    /**
     * Send outgoing audio to the SIP client
     */
    sendAudio(pcm16: Buffer): void {
        for (const call of this.activeCalls.values()) {
            if (call.sipClient) {
                call.sipClient.sendAudio(pcm16);
            }
        }
    }

    /**
     * Stop outgoing audio on all active calls (for barge-in)
     */
    stopAudio(): void {
        for (const call of this.activeCalls.values()) {
            if (call.sipClient) {
                call.sipClient.stopAudio();
            }
        }
    }

    /**
     * Get active calls
     */
    getActiveCalls(): string[] {
        return Array.from(this.activeCalls.keys());
    }
}
