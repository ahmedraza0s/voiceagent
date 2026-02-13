import { RoomServiceClient } from 'livekit-server-sdk';
import config from '../../config';
import logger from '../../utils/logger';
import { EventEmitter } from 'events';

/**
 * LiveKit Room Management Service
 * Handles server-side room management for voice calls
 * 
 * Note: This uses the server SDK. For actual audio streaming, the bot would need to connect
 * using the client SDK (livekit-client) or a headless participant library.
 */
export class LiveKitRoomService extends EventEmitter {
    private roomService: RoomServiceClient;

    constructor() {
        super();
        this.roomService = new RoomServiceClient(
            config.livekit.url,
            config.livekit.apiKey,
            config.livekit.apiSecret
        );
    }

    /**
     * Create a new LiveKit room
     */
    async createRoom(roomName: string): Promise<void> {
        try {
            logger.info('Creating LiveKit room', { roomName });

            await this.roomService.createRoom({
                name: roomName,
                emptyTimeout: 300, // 5 minutes
                maxParticipants: 10,
            });

            logger.info('LiveKit room created', { roomName });
        } catch (error) {
            logger.error('Failed to create LiveKit room', { error });
            throw error;
        }
    }

    /**
     * Get room information
     */
    async getRoomInfo(roomName: string): Promise<any> {
        try {
            const rooms = await this.roomService.listRooms([roomName]);
            return rooms.length > 0 ? rooms[0] : null;
        } catch (error) {
            logger.error('Failed to get room info', { error, roomName });
            return null;
        }
    }

    /**
     * List all participants in a room
     */
    async listParticipants(roomName: string): Promise<any[]> {
        try {
            const participants = await this.roomService.listParticipants(roomName);
            return participants;
        } catch (error) {
            logger.error('Failed to list participants', { error, roomName });
            return [];
        }
    }

    /**
     * Delete a room
     */
    async deleteRoom(roomName: string): Promise<void> {
        try {
            await this.roomService.deleteRoom(roomName);
            logger.info('LiveKit room deleted', { roomName });
        } catch (error) {
            logger.error('Failed to delete room', { error, roomName });
        }
    }

    /**
     * Check if room exists
     */
    async roomExists(roomName: string): Promise<boolean> {
        const info = await this.getRoomInfo(roomName);
        return info !== null;
    }
}
