import {
    SipClient,
    CreateSipInboundTrunkOptions,
    CreateSipOutboundTrunkOptions,
} from 'livekit-server-sdk';
import config from '../../config';
import logger from '../../utils/logger';
import { SIPTransport } from '@livekit/protocol';

/**
 * LiveKit SIP Manager
 * Programmatically manages SIP trunks and dispatch rules on the LiveKit server.
 */
export class LiveKitSIPManager {
    private client: SipClient;

    constructor() {
        this.client = new SipClient(
            config.livekit.url,
            config.livekit.apiKey,
            config.livekit.apiSecret
        );
    }

    /**
     * Create an inbound SIP trunk
     */
    async createInboundTrunk(name: string, numbers: string[], options: Partial<CreateSipInboundTrunkOptions> = {}) {
        try {
            logger.info('Creating LiveKit Inbound SIP Trunk', { name, numbers });
            const trunk = await this.client.createSipInboundTrunk(name, numbers, options);
            logger.info('✅ Inbound Trunk created', { id: trunk.sipTrunkId });
            return trunk;
        } catch (error: any) {
            logger.error('Failed to create inbound trunk', { error: error.message });
            throw error;
        }
    }

    /**
     * Create an outbound SIP trunk
     */
    async createOutboundTrunk(name: string, address: string, numbers: string[], options: Partial<CreateSipOutboundTrunkOptions> = {}) {
        try {
            logger.info('Creating LiveKit Outbound SIP Trunk', { name, address, numbers });
            const trunk = await this.client.createSipOutboundTrunk(name, address, numbers, {
                transport: SIPTransport.SIP_TRANSPORT_UDP,
                ...options
            });
            logger.info('✅ Outbound Trunk created', { id: trunk.sipTrunkId });
            return trunk;
        } catch (error: any) {
            logger.error('Failed to create outbound trunk', { error: error.message });
            throw error;
        }
    }

    /**
     * List all SIP trunks
     */
    async listTrunks() {
        try {
            const inbound = await this.client.listSipInboundTrunk();
            const outbound = await this.client.listSipOutboundTrunk();
            return {
                inbound,
                outbound
            };
        } catch (error: any) {
            logger.error('Failed to list SIP trunks', { error: error.message });
            throw error;
        }
    }

    /**
     * Delete a SIP trunk
     */
    async deleteTrunk(trunkId: string) {
        try {
            logger.info('Deleting SIP Trunk', { trunkId });
            await this.client.deleteSipTrunk(trunkId);
            logger.info('✅ Trunk deleted', { trunkId });
        } catch (error: any) {
            logger.error('Failed to delete SIP trunk', { error: error.message, trunkId });
            throw error;
        }
    }

    /**
     * Create a SIP dispatch rule (Direct)
     */
    async createDirectDispatchRule(name: string, roomName: string, trunkIds?: string[]) {
        try {
            logger.info('Creating Direct SIP Dispatch Rule', { name, roomName });
            const rule = await this.client.createSipDispatchRule(
                { type: 'direct', roomName },
                { name, trunkIds }
            );
            logger.info('✅ Dispatch Rule created', { id: rule.sipDispatchRuleId });
            return rule;
        } catch (error: any) {
            logger.error('Failed to create dispatch rule', { error: error.message });
            throw error;
        }
    }

    /**
     * List all SIP dispatch rules
     */
    async listDispatchRules() {
        try {
            return await this.client.listSipDispatchRule();
        } catch (error: any) {
            logger.error('Failed to list dispatch rules', { error: error.message });
            throw error;
        }
    }

    /**
     * Delete a SIP dispatch rule
     */
    async deleteDispatchRule(ruleId: string) {
        try {
            logger.info('Deleting SIP Dispatch Rule', { ruleId });
            await this.client.deleteSipDispatchRule(ruleId);
            logger.info('✅ Dispatch Rule deleted', { ruleId });
        } catch (error: any) {
            logger.error('Failed to delete dispatch rule', { error: error.message, ruleId });
            throw error;
        }
    }
}
