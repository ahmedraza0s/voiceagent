/**
 * Audio Transcoder Utility
 * Handles conversion between PCM and G.711 mu-law, 
 * and resampling between 8kHz and 16kHz.
 */
export class AudioTranscoder {
    // mu-law compression table (linear to mu-law)
    private static readonly pcmToMuLawTable: Uint8Array = new Uint8Array(65536);
    // mu-law expansion table (mu-law to linear)
    private static readonly muLawToPcmTable: Int16Array = new Int16Array(256);

    static {
        // Initialize tables
        for (let i = 0; i < 256; i++) {
            let mu = ~i;
            let sign = (mu & 0x80);
            let exponent = (mu & 0x70) >> 4;
            let mantissa = (mu & 0x0F);
            let sample = (mantissa << (exponent + 3)) + 132;
            if (exponent > 0) {
                sample += (1 << (exponent + 2));
            }
            sample = (sign !== 0) ? (132 - sample) : (sample - 132);
            this.muLawToPcmTable[i] = sample;
        }

        for (let i = -32768; i <= 32767; i++) {
            let sample = i;
            let sign = (sample < 0) ? 0x80 : 0x00;
            if (sample < 0) sample = -sample;

            sample += 132;
            if (sample > 32635) sample = 32635;

            let exponent = 7;
            for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);

            let mantissa = (sample >> (exponent + 3)) & 0x0F;
            let mu = ~(sign | (exponent << 4) | mantissa);

            this.pcmToMuLawTable[i + 32768] = mu & 0xFF;
        }
    }

    /**
     * Convert 16-bit PCM (16kHz) to mu-law (8kHz)
     * Includes simple anti-aliasing and gain control (0.8x) to prevent clipping.
     */
    static pcm16ToMuLaw8(pcmBuffer: Buffer, gain: number = 0.8): Buffer {
        const numSamples = Math.floor(pcmBuffer.length / 2);
        const targetSamples = Math.floor(numSamples / 2);
        const muLawBuffer = Buffer.alloc(targetSamples);

        for (let i = 0; i < targetSamples; i++) {
            const sample1 = pcmBuffer.readInt16LE(i * 4);
            const sample2 = pcmBuffer.readInt16LE(i * 4 + 2);

            // Average and apply gain to prevent distortion/clipping
            let averagedPcm = Math.floor(((sample1 + sample2) / 2) * gain);

            // Clamp to Int16 range
            averagedPcm = Math.max(-32768, Math.min(32767, averagedPcm));

            muLawBuffer[i] = this.pcmToMuLawTable[averagedPcm + 32768];
        }

        return muLawBuffer;
    }

    /**
     * Convert mu-law (8kHz) to 16-bit PCM (16kHz)
     */
    static muLaw8ToPcm16(muLawBuffer: Buffer): Buffer {
        const pcm8 = Buffer.alloc(muLawBuffer.length * 2);
        for (let i = 0; i < muLawBuffer.length; i++) {
            pcm8.writeInt16LE(this.muLawToPcmTable[muLawBuffer[i]], i * 2);
        }
        return this.resample8To16(pcm8);
    }

    /**
     * Resample 8kHz PCM16 to 16kHz PCM16
     * Uses linear interpolation for smoother sound.
     */
    static resample8To16(pcm8: Buffer): Buffer {
        const numSamples = pcm8.length / 2;
        const target = Buffer.alloc(pcm8.length * 2);

        for (let i = 0; i < numSamples; i++) {
            const current = pcm8.readInt16LE(i * 2);
            const next = i < numSamples - 1 ? pcm8.readInt16LE((i + 1) * 2) : current;

            // Sample 1 (Original)
            target.writeInt16LE(current, i * 4);
            // Sample 2 (Linearly interpolated)
            const interpolated = Math.floor((current + next) / 2);
            target.writeInt16LE(interpolated, i * 4 + 2);
        }
        return target;
    }

    /**
     * Resample 16kHz PCM16 to 8kHz PCM16
     */
    static resample16To8(pcm16: Buffer): Buffer {
        const numSamples = pcm16.length / 2;
        const targetSamples = Math.floor(numSamples / 2);
        const target = Buffer.alloc(targetSamples * 2);

        for (let i = 0; i < targetSamples; i++) {
            const sample = pcm16.readInt16LE(i * 4);
            target.writeInt16LE(sample, i * 2);
        }
        return target;
    }
}
