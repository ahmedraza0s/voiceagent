import { RoomServiceClient } from 'livekit-server-sdk';
import logger from '../../utils/logger';
import config from '../../config';

/**
 * LiveKit SIP Manager (Simplified)
 * 
 * IMPORTANT: This is a PLACEHOLDER implementation.
 * LiveKit SIP requires configuration through the LiveKit Cloud dashboard.
 * 
 * Steps to enable full SIP functionality:
 * 1. Go to https://cloud.livekit.io
 * 2. Configure SIP trunk with VivPhone credentials
 * 3. Get trunk ID from dashboard
 * 4. Use LiveKit's SIP Dispatch API to route calls
 */
export class LiveKitSIPTrunkManager {
    private roomService: RoomServiceClient;

    constructor() {
        this.roomService = new RoomServiceClient(
            config.livekit.url,
            config.livekit.apiKey,
            config.livekit.apiSecret
        );
    }

    /**
     * Create room for SIP call
     */
    async createRoomForCall(roomName: string): Promise<void> {
        await this.roomService.createRoom({
            name: roomName,
            emptyTimeout: 300,
            maxParticipants: 10,
        });
    }

    /**
     * Make a call (requires LiveKit SIP to be configured)
     * 
     * NOTE: This will throw an error until you:
     * 1. Configure SIP trunk in LiveKit dashboard
     * 2. Enable SIP in your LiveKit project
     */
    async makeCall(_phoneNumber: string, _roomName: string): Promise<string> {
        logger.warn('⚠️  LiveKit SIP not fully configured!');
        logger.warn('This requires manual setup in LiveKit Cloud dashboard');
        logger.warn('See LIVEKIT_SIP_SETUP.md for instructions');

        throw new Error(
            'LiveKit SIP not configured. ' +
            'Please set up SIP trunk in LiveKit dashboard. ' +
            'See LIVEKIT_SIP_SETUP.md for detailed instructions.'
        );
    }
}
