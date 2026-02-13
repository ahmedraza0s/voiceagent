
import {
    Room,
    RoomEvent,
    RemoteParticipant,
    RemoteTrack,
    Track,
    AudioStream,
    AudioSource,
    AudioFrame,
    LocalAudioTrack,
    TrackKind,
    TrackPublishOptions
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { EventEmitter } from 'events';
import config from '../../config';
import logger from '../../utils/logger';

/**
 * LiveKit Agent
 * Connects to a room as a participant to handle audio I/O using @livekit/rtc-node
 */
export class LiveKitAgent extends EventEmitter {
    private room: Room;
    private audioSource: AudioSource | null = null;
    private localAudioTrack: LocalAudioTrack | null = null;
    private audioStream: AudioStream | null = null;
    private isConnected: boolean = false;
    private participantName: string = 'AI Agent';

    constructor() {
        super();
        this.room = new Room();
        this.setupRoomEvents();
    }

    private setupRoomEvents(): void {
        this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: any, participant: RemoteParticipant) => {
            if (track.kind === TrackKind.KIND_AUDIO) {
                logger.info('🎤 Audio track subscribed', { participant: participant.identity });
                this.handleAudioTrack(track as any);
            }
        });

        this.room.on(RoomEvent.Disconnected, () => {
            logger.info('LiveKit Agent disconnected');
            this.isConnected = false;
            this.emit('disconnected');
            this.cleanup();
        });

        this.room.on(RoomEvent.Connected, () => {
            logger.info('LiveKit Agent connected to room');
        });
    }

    /**
     * Handle incoming audio track from user
     */
    private handleAudioTrack(track: RemoteTrack): void {
        this.audioStream = new AudioStream(track, 16000, 1);

        logger.info('Started listening to audio stream');

        const readAudio = async () => {
            if (!this.audioStream) return;

            try {
                for await (const frame of this.audioStream) {
                    if (frame.data) {
                        const pcm16 = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
                        this.emit('audio', pcm16);
                    }
                }
            } catch (error) {
                logger.error('Error reading audio stream', { error });
            }
        };

        readAudio();
    }

    /**
     * Connect to the room
     */
    async connect(roomName: string, participantName: string): Promise<void> {
        this.participantName = participantName;

        const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
            identity: `ai-agent-${roomName}`,
            name: participantName,
        });

        at.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canSubscribe: true
        });

        const token = await at.toJwt();

        logger.info('Connecting to LiveKit room...', { url: config.livekit.url, roomName });

        await this.room.connect(config.livekit.url, token);
        this.isConnected = true;

        await this.setupAudioOutput();
    }

    /**
     * Set up the local audio track for the AI to speak
     */
    private async setupAudioOutput(): Promise<void> {
        this.audioSource = new AudioSource(16000, 1);

        if (this.audioSource) {
            this.localAudioTrack = LocalAudioTrack.createAudioTrack('ai_voice', this.audioSource);
            await this.room.localParticipant?.publishTrack(this.localAudioTrack, new TrackPublishOptions());
            logger.info('Published AI audio track');
        }
    }

    /**
     * Push audio to the room (AI Speaking)
     * Expects PCM16 16kHz mono Buffer
     */
    async pushAudio(pcm16: Buffer): Promise<void> {
        if (!this.audioSource || !this.isConnected) return;

        const int16Data = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.length / 2);

        const frame = new AudioFrame(
            int16Data,
            16000,
            1,
            int16Data.length
        );

        await this.audioSource.captureFrame(frame);
    }

    /**
     * Disconnect and cleanup
     */
    async disconnect(): Promise<void> {
        if (this.room) {
            await this.room.disconnect();
        }
        this.cleanup();
    }

    private cleanup(): void {
        this.audioStream = null;

        if (this.audioSource) {
            this.audioSource.close();
            this.audioSource = null;
        }

        this.localAudioTrack = null;
    }
}
