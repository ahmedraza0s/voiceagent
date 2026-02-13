
import { EventEmitter } from 'events';
import { Buffer } from 'node:buffer';
import { DirectSIPDialer } from './direct-dialer';
import { LiveKitRoomService } from '../rooms/livekit';
import { LiveKitPhoneBridge } from '../rooms/livekit-phone-bridge';
import logger from '../../utils/logger';

export interface SIPCallOptions {
    phoneNumber: string;
}

/**
 * SIP Service - Manages Local SIP Gateway
 * 1. Creates LiveKit Room
 * 2. Dials Phone via DirectSIPDialer (Local SIP)
 * 3. Bridges Audio via LiveKitPhoneBridge
 */
export class SIPService extends EventEmitter {
    private dialer: DirectSIPDialer;
    private roomService: LiveKitRoomService;
    private bridges: Map<string, LiveKitPhoneBridge> = new Map(); // roomName -> Bridge
    private sipToRoom: Map<string, string> = new Map(); // sipCallId -> roomName

    constructor() {
        super();
        this.dialer = new DirectSIPDialer();
        this.roomService = new LiveKitRoomService();

        this.setupDialerEvents();
    }

    private setupDialerEvents(): void {
        this.dialer.on('callConnected', ({ callId, phoneNumber }) => {
            const roomName = this.sipToRoom.get(callId);
            if (roomName) {
                logger.info('✅ SIP Call Connected, ready for AI', { roomName, callId });
                this.emit('callConnected', { callId: roomName, phoneNumber });
            }
        });

        this.dialer.on('callEnded', ({ callId }) => {
            const roomName = this.sipToRoom.get(callId);
            if (roomName) {
                logger.info('SIP Call Ended, cleaning up room', { roomName });
                this.endCall(roomName);
            }
        });

        this.dialer.on('callFailed', ({ callId, error }) => {
            const roomName = this.sipToRoom.get(callId);
            if (roomName) {
                logger.error('SIP Call Failed', { roomName, error });
                this.endCall(roomName);
            }
        });

        // Audio from Phone (SIP) -> LiveKit Room
        this.dialer.on('audio', ({ callId, pcm16 }) => {
            const roomName = this.sipToRoom.get(callId);
            if (roomName) {
                const bridge = this.bridges.get(roomName);
                if (bridge) {
                    bridge.pushAudio(pcm16);
                }
            }
        });
    }

    /**
     * Make an outbound call via Local SIP Gateway
     */
    async makeOutboundCall(phoneNumber: string): Promise<string> {
        try {
            const roomName = `call-${Date.now()}`;
            logger.info('🔄 Initiating Local SIP Gateway call', { phoneNumber, roomName });

            // 1. Create LiveKit Room
            await this.roomService.createRoom(roomName);

            // 2. Start SIP Call
            const sipCallId = await this.dialer.makeCall(phoneNumber);
            this.sipToRoom.set(sipCallId, roomName);

            // 3. Connect Bridge (Phone Participant)
            const bridge = new LiveKitPhoneBridge();
            await bridge.connect(roomName, phoneNumber);
            this.bridges.set(roomName, bridge);

            // 4. Audio from LiveKit Room -> Phone (SIP)
            bridge.on('audio', (pcm16: Buffer) => {
                // TODO: In the future, target specific callId.
                // For now, DirectSIPDialer broadcasts to all.
                this.dialer.sendAudio(pcm16);
            });

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

            // 1. Find SIP Call ID
            let sipCallId: string | undefined;
            for (const [id, room] of this.sipToRoom.entries()) {
                if (room === roomName) {
                    sipCallId = id;
                    break;
                }
            }

            // 2. End SIP Call
            if (sipCallId) {
                await this.dialer.endCall(sipCallId);
                this.sipToRoom.delete(sipCallId);
            }

            // 3. Disconnect Bridge
            const bridge = this.bridges.get(roomName);
            if (bridge) {
                await bridge.disconnect();
                this.bridges.delete(roomName);
            }

            // 4. Delete Room
            await this.roomService.deleteRoom(roomName);
            this.emit('callEnded', { callId: roomName });

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

    // Deprecated / Unused in this flow
    async handleInboundCall(callId: string): Promise<string> {
        return callId;
    }

    sendAudio(_pcm16: Buffer): void {
        // No-op
    }

    stopAudio(): void {
        this.dialer.stopAudio();
    }
}
