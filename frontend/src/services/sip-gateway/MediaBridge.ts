import { EventEmitter } from 'events';
import logger from '../../utils/logger';
import dgram from 'dgram';
import {
    Room,
    RoomEvent,
    RemoteParticipant,
    RemoteTrack,
    AudioSource,
    AudioFrame,
    AudioStream,
    LocalAudioTrack,
    TrackKind,
    TrackPublishOptions
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import config from '../../config';
import { AudioTranscoder } from '../../utils/audio-transcoder';

export class MediaBridge extends EventEmitter {
    private socket: dgram.Socket;
    public port: number;
    private room: Room | null = null;
    private audioSource: AudioSource | null = null;
    private localAudioTrack: LocalAudioTrack | null = null;
    private remoteRtpPort: number = 0;
    private remoteRtpAddress: string = '';
    private rtpSequenceNumber: number = 0;
    private rtpTimestamp: number = 0;
    private isBridging: boolean = false;

    constructor(port: number) {
        super();
        this.port = port;
        this.socket = dgram.createSocket('udp4');
    }

    async start() {
        return new Promise<void>((resolve, reject) => {
            this.socket.bind(this.port, () => {
                logger.info(`MediaBridge listening on UDP port ${this.port}`);
                resolve();
            });

            this.socket.on('message', (msg) => {
                this.handleIncomingRtp(msg);
            });

            this.socket.on('error', (err) => {
                logger.error(`MediaBridge error: ${err.message}`);
                reject(err);
            });
        });
    }

    stop() {
        this.isBridging = false;
        if (this.room) {
            this.room.disconnect();
            this.room = null;
        }
        this.socket.close();
        logger.info('MediaBridge stopped');
    }

    private async handleIncomingRtp(msg: Buffer) {
        if (!this.isBridging || !this.audioSource) return;

        // Simple RTP header check (V=2, Payload Type=0 for PCMU)
        // Header is 12 bytes
        if (msg.length < 12) return;

        const payloadType = msg[1] & 0x7F;
        if (payloadType !== 0) {
            // Only handle PCMU for now
            return;
        }

        const payload = msg.subarray(12);

        // Convert PCMU (8kHz) to PCM16 (16kHz)
        const pcm16 = AudioTranscoder.muLaw8ToPcm16(payload);

        // Push to LiveKit
        const int16Data = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.length / 2);
        const frame = new AudioFrame(
            int16Data,
            16000,
            1,
            int16Data.length
        );

        try {
            await this.audioSource.captureFrame(frame);
        } catch (error) {
            logger.error('Failed to capture audio frame in MediaBridge', { error });
        }
    }

    async bridgeToRoom(roomName: string, remoteRtpPort: number, remoteRtpAddress: string) {
        logger.info(`Bridging RTP to room ${roomName} <-> ${remoteRtpAddress}:${remoteRtpPort}`);
        this.remoteRtpPort = remoteRtpPort;
        this.remoteRtpAddress = remoteRtpAddress;

        try {
            // 1. Join the LiveKit room as a Bridge participant
            this.room = new Room();

            const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
                identity: `sip-bridge-${roomName}`,
                name: 'SIP Bridge',
            });
            at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
            const token = await at.toJwt();

            await this.room.connect(config.livekit.url, token);
            logger.info('MediaBridge connected to LiveKit room');

            // 2. Setup Audio Source to push caller audio to room
            this.audioSource = new AudioSource(16000, 1);
            this.localAudioTrack = LocalAudioTrack.createAudioTrack('caller_audio', this.audioSource);
            await this.room.localParticipant?.publishTrack(this.localAudioTrack, new TrackPublishOptions());
            logger.info('Published caller audio track to room');

            // 3. Listen for AI audio track and bridge back to SIP
            this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication: any, participant: RemoteParticipant) => {
                if (track.kind === TrackKind.KIND_AUDIO && participant.identity.startsWith('ai-agent-')) {
                    logger.info(`Bridging AI audio from ${participant.identity} back to SIP`);
                    this.bridgeOutboundAudio(track as any);
                }
            });

            this.isBridging = true;
        } catch (error) {
            logger.error('Failed to bridge MediaBridge to LiveKit room', { error });
            throw error;
        }
    }

    private async bridgeOutboundAudio(track: RemoteTrack) {
        const stream = new AudioStream(track, 16000, 1);

        try {
            for await (const frame of stream) {
                if (!this.isBridging) break;
                if (frame.data) {
                    const pcm16 = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);

                    // Convert PCM16 (16kHz) to PCMU (8kHz)
                    const muLaw = AudioTranscoder.pcm16ToMuLaw8(pcm16);

                    // Create RTP Packet
                    const rtpPacket = this.createRtpPacket(muLaw);

                    // Send to remote SIP endpoint
                    this.socket.send(rtpPacket, this.remoteRtpPort, this.remoteRtpAddress);
                }
            }
        } catch (error) {
            logger.error('Error in outbound audio bridging', { error });
        }
    }

    private createRtpPacket(payload: Buffer): Buffer {
        const header = Buffer.alloc(12);

        // V=2, P=0, X=0, CC=0 => 0x80
        header[0] = 0x80;
        // M=0, PT=0 (PCMU) => 0x00
        header[1] = 0x00;

        header.writeUInt16BE(this.rtpSequenceNumber++, 2);
        header.writeUInt32BE(this.rtpTimestamp, 4);
        header.writeUInt32BE(0x12345678, 8); // SSRC (fixed for now)

        // 8kHz PCMU = 8 samples per ms. Assuming 20ms chunks (160 samples)
        this.rtpTimestamp += payload.length;

        if (this.rtpSequenceNumber > 0xFFFF) this.rtpSequenceNumber = 0;

        return Buffer.concat([header, payload]);
    }
}
