import { EventEmitter } from 'events';
import dgram from 'dgram';
import logger from '../../utils/logger';
import { AudioTranscoder } from '../../utils/audio-transcoder';

/**
 * FreeSwitchAudioBridge
 *
 * Replaces LiveKitAgent + MediaBridge.
 * Exchanges raw PCM16 audio with FreeSWITCH via a local UDP RTP socket.
 *
 * FreeSWITCH sends RTP (PCMU/8kHz) → we decode to PCM16/16kHz → emit 'audio' events → STT
 * TTS produces PCM16/16kHz → we encode to PCMU/8kHz → send RTP back to FreeSWITCH → caller hears AI
 *
 * Events:
 *   'audio'        - Buffer (PCM16 16kHz mono) - caller audio for STT
 *   'ready'        - bridge is listening and ready
 *   'error'        - Error
 */
export class FreeSwitchAudioBridge extends EventEmitter {
    private socket: dgram.Socket;
    private localPort: number;
    private remotePort: number = 0;
    private remoteAddress: string = '';
    private rtpSequenceNumber: number = 0;
    private rtpTimestamp: number = 0;
    private isBridging: boolean = false;

    // RTP Pacing
    private outboundQueue: Buffer[] = [];
    private pacerInterval: NodeJS.Timeout | null = null;
    private readonly CHUNK_SIZE_MS = 20;
    private readonly SAMPLE_RATE_HZ = 8000;
    private readonly SAMPLES_PER_CHUNK = (this.SAMPLE_RATE_HZ * this.CHUNK_SIZE_MS) / 1000; // 160 samples

    constructor(localPort: number = 0) {
        super();
        this.localPort = localPort;
        this.socket = dgram.createSocket('udp4');
    }

    /**
     * Start listening for RTP from FreeSWITCH
     */
    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket.bind(this.localPort, () => {
                const address = this.socket.address();
                this.localPort = address.port;
                logger.info(`FreeSwitchAudioBridge listening on UDP port ${this.localPort}`);
                this.isBridging = true;
                this.startPacer();
                this.emit('ready');
                resolve();
            });

            this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
                // Auto-detect remote address from first packet
                if (!this.remoteAddress) {
                    this.remoteAddress = rinfo.address;
                    this.remotePort = rinfo.port;
                    logger.info(`FreeSWITCH RTP source detected: ${rinfo.address}:${rinfo.port}`);
                }
                this.handleIncomingRtp(msg);
            });

            this.socket.on('error', (err: Error) => {
                logger.error(`FreeSwitchAudioBridge socket error: ${err.message}`);
                this.emit('error', err);
                reject(err);
            });
        });
    }

    /**
     * Start the real-time pacer for outbound audio
     */
    private startPacer(): void {
        if (this.pacerInterval) return;

        this.pacerInterval = setInterval(() => {
            if (!this.isBridging || !this.remoteAddress || !this.remotePort) return;
            if (this.outboundQueue.length === 0) return;

            const payload = this.outboundQueue.shift()!;
            const rtpPacket = this.createRtpPacket(payload);

            this.socket.send(rtpPacket, this.remotePort, this.remoteAddress, (err) => {
                if (err) {
                    logger.error('Failed to send RTP packet', { error: err.message });
                }
            });
        }, this.CHUNK_SIZE_MS);
    }

    /**
     * Set the remote RTP endpoint (FreeSWITCH media address from SDP)
     */
    setRemoteEndpoint(address: string, port: number): void {
        this.remoteAddress = address;
        this.remotePort = port;
        logger.info(`FreeSwitchAudioBridge remote endpoint set: ${address}:${port}`);
    }

    /**
     * Process incoming RTP packet from FreeSWITCH (caller audio)
     */
    private handleIncomingRtp(msg: Buffer): void {
        if (!this.isBridging) return;

        // RTP header is at least 12 bytes
        if (msg.length < 12) return;

        const payloadType = msg[1] & 0x7F;

        // Only handle PCMU (PT=0) for now
        if (payloadType !== 0) return;

        const payload = msg.subarray(12);

        // Convert PCMU 8kHz → PCM16 16kHz
        const pcm16 = AudioTranscoder.muLaw8ToPcm16(payload);

        this.emit('audio', pcm16);
    }

    /**
     * Send PCM16 audio (from TTS) back to FreeSWITCH as RTP
     * Input: PCM16 16kHz mono Buffer
     */
    pushAudio(pcm16: Buffer): void {
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

    /**
     * Build a minimal RTP packet (PCMU, PT=0)
     */
    private createRtpPacket(payload: Buffer): Buffer {
        const header = Buffer.alloc(12);

        header[0] = 0x80;           // V=2, P=0, X=0, CC=0
        header[1] = 0x00;           // M=0, PT=0 (PCMU)
        header.writeUInt16BE(this.rtpSequenceNumber & 0xFFFF, 2);
        header.writeUInt32BE(this.rtpTimestamp >>> 0, 4);
        header.writeUInt32BE(0xABCD1234, 8); // SSRC

        this.rtpSequenceNumber = (this.rtpSequenceNumber + 1) & 0xFFFF;
        this.rtpTimestamp = (this.rtpTimestamp + payload.length) >>> 0;

        return Buffer.concat([header, payload]);
    }

    /**
     * Clear the outbound audio queue (barge-in)
     */
    clearOutboundQueue(): void {
        this.outboundQueue = [];
        logger.info('FreeSwitchAudioBridge: outbound queue cleared');
    }

    /**
     * Stop the bridge and close the socket
     */
    stop(): void {
        this.isBridging = false;
        if (this.pacerInterval) {
            clearInterval(this.pacerInterval);
            this.pacerInterval = null;
        }
        this.clearOutboundQueue();
        try {
            this.socket.close();
        } catch (_) {
            // Already closed
        }
        logger.info('FreeSwitchAudioBridge stopped');
    }

    get localRtpPort(): number {
        return this.localPort;
    }
}
