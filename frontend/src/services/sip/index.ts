
import { EventEmitter } from 'events';
import { LiveKitRoomService } from '../rooms/livekit';
import { LiveKitSIPManager } from './livekit-sip-manager';
import logger from '../../utils/logger';

export interface SIPCallOptions {
    phoneNumber: string;
}

/**
 * SIP Service - Manages LiveKit SIP Integration
 * Uses LiveKit's native SIP service instead of custom dialer
 */
export class SIPService extends EventEmitter {
    private roomService: LiveKitRoomService;
    private sipManager: LiveKitSIPManager;
    private activeCalls: Map<string, any> = new Map(); // roomName -> call info

    constructor() {
        super();
        this.roomService = new LiveKitRoomService();
        this.sipManager = new LiveKitSIPManager();
    }

    /**
     * Make an outbound call via LiveKit SIP
     */
    async makeOutboundCall(phoneNumber: string): Promise<string> {
        try {
            const roomName = `call-${Date.now()}`;
            logger.info('🔄 Initiating LiveKit SIP call', { phoneNumber, roomName });

            // 1. Create LiveKit Room
            await this.roomService.createRoom(roomName);

            // 2. Get or create default SIP trunk
            const trunkId = await this.sipManager.getOrCreateDefaultTrunk();

            // 3. Create SIP Participant (LiveKit handles the call and audio)
            const participant = await this.sipManager.createSipParticipant(
                roomName,
                trunkId,
                phoneNumber
            );

            // Track active call
            this.activeCalls.set(roomName, {
                phoneNumber,
                trunkId,
                participantId: participant.participantId,
                sipCallId: participant.sipCallId,
                startTime: new Date()
            });

            logger.info('✅ LiveKit SIP call initiated', {
                roomName,
                phoneNumber,
                participantId: participant.participantId
            });

            // Emit call connected event (LiveKit handles the actual connection)
            // In a real implementation, you'd listen to LiveKit webhooks for actual connection status
            setTimeout(() => {
                this.emit('callConnected', { callId: roomName, phoneNumber });
            }, 2000);

            return roomName;
        } catch (error: any) {
            logger.error('Failed to make outbound call', { error: error.message, phoneNumber });
            throw error;
        }
    }

    /**
     * End an active call
     */
    async endCall(roomName: string): Promise<void> {
        try {
            logger.info('Ending call sequence', { roomName });

            const callInfo = this.activeCalls.get(roomName);
            if (callInfo) {
                logger.info('Call info', callInfo);
                this.activeCalls.delete(roomName);
            }

            // Delete the room (this will disconnect all participants including SIP)
            await this.roomService.deleteRoom(roomName);
            this.emit('callEnded', { callId: roomName });

            logger.info('✅ Call ended successfully', { roomName });

        } catch (error: any) {
            logger.error('Error ending call', { error: error.message, roomName });
            throw error;
        }
    }

    /**
     * Alias for endCall
     */
    async deleteRoom(roomName: string): Promise<void> {
        return this.endCall(roomName);
    }

    /**
     * Handle inbound call (placeholder for future implementation)
     */
    async handleInboundCall(callId: string): Promise<string> {
        logger.info('Inbound call handling not yet implemented', { callId });
        return callId;
    }

    /**
     * Stop audio playback (no-op for LiveKit managed SIP)
     */
    stopAudio(): void {
        // LiveKit handles audio management internally
        logger.debug('stopAudio called (handled by LiveKit)');
    }

    /**
     * Send audio (no-op for LiveKit managed SIP)
     */
    sendAudio(_pcm16: Buffer): void {
        // LiveKit handles audio routing internally
        logger.debug('sendAudio called (handled by LiveKit)');
    }

    /**
     * Get active calls
     */
    getActiveCalls(): string[] {
        return Array.from(this.activeCalls.keys());
    }

    /**
     * Get call information
     */
    getCallInfo(roomName: string): any {
        return this.activeCalls.get(roomName);
    }
}
