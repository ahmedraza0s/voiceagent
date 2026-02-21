import { EventEmitter } from 'events';
import logger from '../../utils/logger';
import dgram from 'dgram';
import { AudioTranscoder } from '../../utils/audio-transcoder';

/**
 * MediaBridge
 *
 * Handles raw RTP audio between the SIP gateway (caller) and the AI pipeline.
 * All LiveKit dependencies have been removed — audio is now bridged directly.
 *
 * Events:
 *   'audio'   - Buffer (PCM16 16kHz) - caller audio ready for STT
 */
export class MediaBridge extends EventEmitter {
    private socket: dgram.Socket;
    public port: number;
    private remoteRtpPort: number = 0;
    private remoteRtpAddress: string = '';
    private rtpSequenceNumber: number = 0;
    private rtpTimestamp: number = 0;
    private isBridging: boolean = false;

    // RTP Pacing
    private outboundQueue: Buffer[] = [];
    private pacerInterval: NodeJS.Timeout | null = null;
    private readonly CHUNK_SIZE_MS = 20;
    private readonly SAMPLE_RATE_HZ = 8000;
    private readonly SAMPLES_PER_CHUNK = (this.SAMPLE_RATE_HZ * this.CHUNK_SIZE_MS) / 1000; // 160

    constructor(port: number = 0) {
        super();
        this.port = port;
        this.socket = dgram.createSocket('udp4');
    }

    async start() {
        return new Promise<void>((resolve, reject) => {
            this.socket.bind(this.port, () => {
                const address = this.socket.address();
                this.port = address.port;
                logger.info(`MediaBridge listening on UDP port ${this.port}`);
                this.startPacer();
                resolve();
            });

            this.socket.on('message', (msg: Buffer) => {
                this.handleIncomingRtp(msg);
            });

            this.socket.on('error', (err: Error) => {
                logger.error(`MediaBridge error: ${err.message}`);
                reject(err);
            });
        });
    }

    private startPacer() {
        if (this.pacerInterval) return;

        this.pacerInterval = setInterval(() => {
            if (!this.isBridging || !this.remoteRtpAddress || !this.remoteRtpPort) return;
            if (this.outboundQueue.length === 0) return;

            const payload = this.outboundQueue.shift()!;
            const rtpPacket = this.createRtpPacket(payload);

            this.socket.send(rtpPacket, this.remoteRtpPort, this.remoteRtpAddress, (err) => {
                if (err) {
                    logger.error('Failed to send MediaBridge RTP packet', { error: err.message });
                }
            });
        }, this.CHUNK_SIZE_MS);
    }

    stop() {
        this.isBridging = false;
        if (this.pacerInterval) {
            clearInterval(this.pacerInterval);
            this.pacerInterval = null;
        }
        this.outboundQueue = [];
        try {
            this.socket.close();
        } catch (_) {
            // Already closed
        }
        logger.info('MediaBridge stopped');
    }

    private handleIncomingRtp(msg: Buffer) {
        if (!this.isBridging) return;

        // RTP header check — minimum 12 bytes
        if (msg.length < 12) return;

        const payloadType = msg[1] & 0x7F;
        if (payloadType !== 0) {
            // Only handle PCMU (PT=0) for now
            return;
        }

        const payload = msg.subarray(12);

        // Convert PCMU (8kHz) to PCM16 (16kHz)
        const pcm16 = AudioTranscoder.muLaw8ToPcm16(payload);

        // Emit to pipeline (STT)
        this.emit('audio', pcm16);
    }

    /**
     * Configure the remote RTP endpoint (from SDP negotiation)
     */
    setRemoteEndpoint(remoteRtpPort: number, remoteRtpAddress: string) {
        this.remoteRtpPort = remoteRtpPort;
        this.remoteRtpAddress = remoteRtpAddress;
        this.isBridging = true;
        logger.info(`MediaBridge remote endpoint: ${remoteRtpAddress}:${remoteRtpPort}`);
    }

    /**
     * Send PCM16 audio (AI TTS output) back to the caller as RTP
     */
    sendAudio(pcm16: Buffer) {
        if (!this.isBridging) return;

        // Convert entire buffer PCM16 16kHz → PCMU 8kHz
        const muLaw = AudioTranscoder.pcm16ToMuLaw8(pcm16);

        // Slice into 20ms chunks (160 bytes for PCMU 8kHz)
        for (let i = 0; i < muLaw.length; i += this.SAMPLES_PER_CHUNK) {
            const chunk = muLaw.subarray(i, i + this.SAMPLES_PER_CHUNK);
            // Pad the last chunk if necessary
            if (chunk.length < this.SAMPLES_PER_CHUNK) {
                const padded = Buffer.alloc(this.SAMPLES_PER_CHUNK, 0x7F); // Silence in PCMU
                chunk.copy(padded);
                this.outboundQueue.push(padded);
            } else {
                this.outboundQueue.push(chunk);
            }
        }
    }

    private createRtpPacket(payload: Buffer): Buffer {
        const header = Buffer.alloc(12);

        header[0] = 0x80;  // V=2, P=0, X=0, CC=0
        header[1] = 0x00;  // M=0, PT=0 (PCMU)
        header.writeUInt16BE(this.rtpSequenceNumber & 0xFFFF, 2);
        header.writeUInt32BE(this.rtpTimestamp >>> 0, 4);
        header.writeUInt32BE(0x12345678, 8); // SSRC

        this.rtpSequenceNumber = (this.rtpSequenceNumber + 1) & 0xFFFF;
        this.rtpTimestamp = (this.rtpTimestamp + payload.length) >>> 0;

        return Buffer.concat([header, payload]);
    }
}
