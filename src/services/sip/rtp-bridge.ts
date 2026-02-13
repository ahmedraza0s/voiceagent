import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import logger from '../../utils/logger';
import { AudioTranscoder } from '../../utils/audio-transcoder';

/**
 * RTP Bridge
 * Handles sending and receiving of RTP audio packets for SIP calls.
 * Bridges SIP (PCMU @ 8kHz) with AI Services (PCM16 @ 16kHz).
 */
export class RTPBridge extends EventEmitter {
    private socket: dgram.Socket;
    private remoteAddress: string | null = null;
    private remotePort: number | null = null;
    private sequenceNumber: number = 0;
    private timestamp: number = 0;
    private ssrc: number = Math.floor(Math.random() * 0xFFFFFFFF);
    private isRunning: boolean = false;
    private localPort: number = 0;
    private audioBuffer: Buffer = Buffer.alloc(0);
    private pacerTimer: NodeJS.Timeout | null = null;
    private packetCount: number = 0;
    private receiveCount: number = 0;

    constructor() {
        super();
        this.socket = dgram.createSocket('udp4');

        this.socket.on('message', (msg) => {
            this.handleRTPPacket(msg);
        });

        this.socket.on('error', (err) => {
            logger.error('RTP Socket error', { error: err.message });
        });
    }

    /**
     * Start the RTP bridge and bind to a local port
     */
    async start(): Promise<number> {
        return new Promise((resolve) => {
            this.socket.bind(0, () => {
                const addr = this.socket.address();
                this.localPort = addr.port;
                this.isRunning = true;
                this.startPacer();
                logger.info('RTP Bridge started', { port: this.localPort });
                resolve(this.localPort);
            });
        });
    }

    /**
     * Set the remote destination for RTP packets
     */
    setRemoteDestination(address: string, port: number): void {
        this.remoteAddress = address;
        this.remotePort = port;
        logger.info('RTP remote destination set', { address, port });
    }

    /**
     * Handle incoming RTP packet
     */
    private handleRTPPacket(packet: Buffer): void {
        if (packet.length < 12) return;

        // Basic RTP Header Parsing
        // Byte 0: V=2, P, X, CC
        // Byte 1: M, PT (7 bits)
        const payloadType = packet[1] & 0x7F;

        // We only support PCMU (Payload Type 0)
        if (payloadType !== 0) return;

        // Payload starts at byte 12 (assuming no CSRC)
        const payload = packet.slice(12);

        // Convert mu-law 8kHz to PCM16 16kHz for AI
        const pcm16 = AudioTranscoder.muLaw8ToPcm16(payload);

        this.receiveCount++;
        if (this.receiveCount % 100 === 0) {
            logger.info('📥 RTP packets received', {
                count: this.receiveCount,
                size: packet.length
            });
        }

        this.emit('audio', pcm16);
    }

    /**
     * Send audio to the remote SIP peer
     * Expects PCM16 16kHz mono audio
     */
    sendAudio(pcm16: Buffer): void {
        if (!this.isRunning || !this.remoteAddress || !this.remotePort) return;

        // Transcode PCM16 16kHz to mu-law 8kHz
        const muLaw = AudioTranscoder.pcm16ToMuLaw8(pcm16);

        // Add to buffer
        this.audioBuffer = Buffer.concat([this.audioBuffer, muLaw]);
    }

    /**
     * Start the pacer timer to send packets at 20ms intervals
     * Uses recursive setTimeout with drift compensation for high precision.
     */
    private startPacer(): void {
        if (this.pacerTimer) return;

        logger.info('🚀 Starting high-resolution RTP pacer (20ms)');

        const INTERVAL_MS = 20;
        let lastTick = process.hrtime();

        const tick = () => {
            if (!this.isRunning) return;

            const chunkSize = 160; // 20ms of PCMU

            // STARTUP BUFFER: Wait for 480 bytes (~60ms) before starting to send
            // This prevents immediate starvation if the next chunk is slightly late.
            if (this.packetCount === 0 && this.audioBuffer.length < 480) {
                // Not enough data yet, wait another 20ms
                this.pacerTimer = setTimeout(tick, INTERVAL_MS);
                return;
            }

            if (this.audioBuffer.length >= chunkSize) {
                const chunk = this.audioBuffer.slice(0, chunkSize);
                this.audioBuffer = this.audioBuffer.slice(chunkSize);
                this.sendRTPPacket(chunk);
            } else if (this.audioBuffer.length > 0) {
                // Buffer starvation!
                if (this.packetCount % 50 === 0) {
                    logger.warn('⚠️ RTP Buffer starvation', { size: this.audioBuffer.length });
                }
            }

            // Calculate drift and schedule next tick
            const now = process.hrtime();
            const elapsedMs = (now[0] - lastTick[0]) * 1000 + (now[1] - lastTick[1]) / 1e6;
            const drift = elapsedMs - INTERVAL_MS;
            const nextDelay = Math.max(0, INTERVAL_MS - drift);

            lastTick = now;
            this.pacerTimer = setTimeout(tick, nextDelay);
        };

        tick();
    }

    /**
     * Wrap payload in RTP header and send
     */
    private sendRTPPacket(payload: Buffer): void {
        const packet = Buffer.alloc(12 + payload.length);

        // V=2, P=0, X=0, CC=0
        packet[0] = 0x80;
        // M=0, PT=0 (PCMU)
        packet[1] = 0x00;

        packet.writeUInt16BE(this.sequenceNumber, 2);
        packet.writeUInt32BE(this.timestamp, 4);
        packet.writeUInt32BE(this.ssrc, 8);

        payload.copy(packet, 12);

        this.socket.send(packet, 0, packet.length, this.remotePort!, this.remoteAddress!, (err) => {
            if (err) {
                logger.error('Error sending RTP packet', { error: err.message });
            } else {
                this.packetCount++;
                if (this.packetCount % 50 === 0) {
                    logger.info('📡 RTP packets flowing', {
                        count: this.packetCount,
                        bufferSize: this.audioBuffer.length,
                        remote: `${this.remoteAddress}:${this.remotePort}`
                    });
                }
            }
        });

        this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
        this.timestamp = (this.timestamp + payload.length) & 0xFFFFFFFF;
    }

    /**
     * Clear the audio buffer immediately (for barge-in)
     */
    clearAudioBuffer(): void {
        const size = this.audioBuffer.length;
        this.audioBuffer = Buffer.alloc(0);
        if (size > 0) {
            logger.info('🗑️ RTP Buffer cleared (Barge-in)', { bytesCleared: size });
        }
    }

    /**
     * Stop the RTP bridge
     */
    stop(): void {
        this.isRunning = false;
        if (this.pacerTimer) {
            clearTimeout(this.pacerTimer);
            this.pacerTimer = null;
        }
        this.socket.close();
        this.audioBuffer = Buffer.alloc(0);
        logger.info('RTP Bridge stopped');
    }

    get port(): number {
        return this.localPort;
    }
}
