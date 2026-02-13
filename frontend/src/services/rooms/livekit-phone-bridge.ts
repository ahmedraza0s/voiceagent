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
 * LiveKit Phone Bridge
 * Acts as the "Phone User" in the LiveKit Room.
 * 1. Receives Audio from SIP (PCM16) -> Publishes to Room (Mic)
 * 2. Receives Audio from Room (AI) -> Emits for SIP (Speaker)
 */
export class LiveKitPhoneBridge extends EventEmitter {
    private room: Room;
    private audioSource: AudioSource | null = null;
    private localAudioTrack: LocalAudioTrack | null = null;
    private audioStream: AudioStream | null = null;
    private isConnected: boolean = false;
    private roomName: string | null = null;

    constructor() {
        super();
        // @ts-ignore
        this.room = new Room();
        this.setupRoomEvents();
    }

    private setupRoomEvents(): void {
        this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: any, participant: RemoteParticipant) => {
            if (track.kind === TrackKind.KIND_AUDIO) {
                // Determine if this is the AI Agent
                const isAgent = participant.identity.startsWith('ai-agent-');
                logger.info('📞 Phone Bridge subscribed to track', { participant: participant.identity, isAgent });

                if (isAgent) {
                    this.handleAudioTrack(track);
                }
            }
        });

        this.room.on(RoomEvent.Disconnected, () => {
            logger.info('Phone Bridge disconnected from LiveKit');
            this.isConnected = false;
            this.emit('disconnected');
            this.cleanup();
        });

        this.room.on(RoomEvent.Connected, () => {
            logger.info('Phone Bridge connected to room');
        });
    }

    /**
     * Handle incoming audio from the Room (AI Speaking)
     * We need to send this to the SIP Client
     */
    private handleAudioTrack(track: RemoteTrack): void {
        // Start reading audio from the track
        // SIP typically uses 8kHz (G.711) or 16kHz (G.722)
        // Our rtp-bridge expects PCM16 16kHz to feed into mu-law encoder
        this.audioStream = new AudioStream(track, 16000, 1);

        logger.info('Bridge listening to AI audio');

        const readAudio = async () => {
            if (!this.audioStream) return;

            try {
                for await (const frame of this.audioStream) {
                    if (frame.data) {
                        // frame.data is Int16Array usually, or Buffer?
                        // @livekit/rtc-node types say int16 array buffer
                        const pcm16 = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
                        this.emit('audio', pcm16);
                    }
                }
            } catch (error) {
                logger.error('Error reading AI audio stream', { error });
            }
        };

        readAudio();
    }

    /**
     * Connect to the room as the "Phone" participant
     */
    async connect(roomName: string, phoneNumber: string): Promise<void> {
        this.roomName = roomName;

        // Create token for the Phone User
        const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
            identity: `phone-${phoneNumber}`,
            name: phoneNumber,
        });

        at.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canSubscribe: true
        });

        const token = await at.toJwt();

        logger.info('Connecting Phone Bridge to LiveKit...', { roomName, identity: `phone-${phoneNumber}` });

        await this.room.connect(config.livekit.url, token);
        this.isConnected = true;

        await this.setupAudioOutput();
    }

    /**
     * Set up the local audio track (To publish SIP audio to Room)
     */
    private async setupAudioOutput(): Promise<void> {
        // Source that we will push SIP audio into
        this.audioSource = new AudioSource(16000, 1);

        if (this.audioSource) {
            this.localAudioTrack = LocalAudioTrack.createAudioTrack('phone_audio', this.audioSource);
            await this.room.localParticipant?.publishTrack(this.localAudioTrack, new TrackPublishOptions());
            logger.info('Published Phone audio track to Room');
        }
    }

    /**
     * Push audio from SIP to the Room
     * Expects PCM16 16kHz mono Buffer
     */
    async pushAudio(pcm16: Buffer): Promise<void> {
        if (!this.audioSource || !this.isConnected) return;

        // Ensure buffer matches what AudioFrame expects (Int16Array)
        // Check if buffer length is even
        if (pcm16.length % 2 !== 0) {
            logger.warn('Received odd buffer length for PCM16', { length: pcm16.length });
            return;
        }

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
        // @ts-ignore
        if (this.audioStream) this.audioStream = null;

        if (this.audioSource) {
            this.audioSource.close();
            this.audioSource = null;
        }

        this.localAudioTrack = null;
    }
}
