import { EventEmitter } from 'events';
import logger from '../../utils/logger';
import { DirectSIPDialer } from './direct-dialer';

export interface SIPCallOptions {
    phoneNumber: string;
}

/**
 * SIP Service - Manages SIP calls using VivPhone Direct Dialer
 */
export class SIPService extends EventEmitter {
    private dialer: DirectSIPDialer;
    private activeCalls: Map<string, { callId: string; phoneNumber: string }>;

    constructor() {
        super();
        this.dialer = new DirectSIPDialer();
        this.activeCalls = new Map();

        // Forward dialer events
        this.dialer.on('callStarted', (data) => this.emit('callStarted', data));
        this.dialer.on('callConnected', (data) => this.emit('callConnected', data));
        this.dialer.on('callEnded', (data) => this.emit('callEnded', data));
        this.dialer.on('audio', (data) => this.emit('audio', data));
    }

    /**
     * Make an outbound call
     */
    async makeOutboundCall(phoneNumber: string): Promise<string> {
        try {
            logger.info('🔄 Initiating direct SIP call', { phoneNumber });
            const callId = await this.dialer.makeCall(phoneNumber);

            // Track active call
            this.activeCalls.set(callId, { callId, phoneNumber });
            return callId;
        } catch (error: any) {
            logger.error('Failed to make outbound call', { error: error.message, phoneNumber });
            throw error;
        }
    }

    /**
     * End an active call
     */
    async endCall(callId: string): Promise<void> {
        try {
            const call = this.activeCalls.get(callId);
            if (!call) {
                logger.warn('No active call found', { callId });
                return;
            }

            await this.dialer.endCall(callId);
            this.activeCalls.delete(callId);
            logger.info('✅ Call ended', { callId });
        } catch (error: any) {
            logger.error('Error ending call', { error: error.message, callId });
            throw error;
        }
    }

    /**
     * Alias for endCall to fix crash in index.ts
     */
    async deleteRoom(roomName: string): Promise<void> {
        return this.endCall(roomName);
    }

    async handleInboundCall(callId: string): Promise<string> {
        // Simple mock for inbound handling - actual implementation would depend on SIP stack
        logger.info('Handling inbound call', { callId });
        return callId;
    }

    /**
     * Send outgoing audio to the active call(s)
     */
    sendAudio(pcm16: Buffer): void {
        this.dialer.sendAudio(pcm16);
    }

    /**
     * Stop outgoing audio (for barge-in)
     */
    stopAudio(): void {
        this.dialer.stopAudio();
    }

    /**
     * Get all active calls
     */
    getActiveCalls(): Array<{ roomName: string; phoneNumber: string }> {
        return Array.from(this.activeCalls.values()).map(c => ({
            roomName: c.callId,
            phoneNumber: c.phoneNumber
        }));
    }
}
