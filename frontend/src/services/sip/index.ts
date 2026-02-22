
import { EventEmitter } from 'events';
import { FreeSwitchService } from '../freeswitch/FreeSwitchService';
import logger from '../../utils/logger';

export interface SIPCallOptions {
    phoneNumber: string;
}

/**
 * SIP Service - Manages FreeSWITCH SIP Integration
 * Delegates all call control to FreeSwitchService (drachtio-srf / ESL).
 */
export class SIPService extends EventEmitter {
    private freeSwitchService: FreeSwitchService;
    private activeCalls: Map<string, any> = new Map(); // callId -> call info

    constructor(freeSwitchService: FreeSwitchService) {
        super();
        this.freeSwitchService = freeSwitchService;

        // Forward FreeSWITCH events
        this.freeSwitchService.on('callConnected', (data) => {
            this.emit('callConnected', data);
        });

        this.freeSwitchService.on('callEnded', (data) => {
            this.activeCalls.delete(data.callId);
            this.emit('callEnded', data);
        });
    }

    /**
     * Make an outbound call via FreeSWITCH
     */
    async makeOutboundCall(phoneNumber: string, localSdp: string, callId?: string, settings?: any): Promise<string> {
        try {
            logger.info('🔄 Initiating FreeSWITCH outbound call', { phoneNumber, callId });

            const finalCallId = await this.freeSwitchService.makeOutboundCall(phoneNumber, localSdp, callId, settings);

            this.activeCalls.set(finalCallId, {
                phoneNumber,
                startTime: new Date(),
            });

            logger.info('✅ FreeSWITCH outbound call initiated', { callId: finalCallId, phoneNumber });
            return finalCallId;
        } catch (error: any) {
            logger.error('Failed to make outbound call', { error: error.message, phoneNumber });
            throw error;
        }
    }

    /**
     * End/hang up a call
     */
    async endCall(callId: string): Promise<void> {
        try {
            logger.info('Ending call', { callId });
            await this.freeSwitchService.hangup(callId);
            this.activeCalls.delete(callId);
            this.emit('callEnded', { callId });
            logger.info('✅ Call ended', { callId });
        } catch (error: any) {
            logger.error('Error ending call', { error: error.message, callId });
            throw error;
        }
    }

    /**
     * Alias for endCall (backward compat)
     */
    async deleteRoom(callId: string): Promise<void> {
        return this.endCall(callId);
    }

    /**
     * Stop audio playback (no-op - handled by pipeline TTS stop)
     */
    stopAudio(): void {
        logger.debug('stopAudio called (handled by TTS pipeline)');
    }

    /**
     * Get active call IDs
     */
    getActiveCalls(): string[] {
        return Array.from(this.activeCalls.keys());
    }

    /**
     * Get call info
     */
    getCallInfo(callId: string): any {
        return this.activeCalls.get(callId);
    }
}
