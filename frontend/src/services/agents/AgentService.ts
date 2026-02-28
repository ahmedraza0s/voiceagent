import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger';
import { query } from '../../database/db';

export interface StartSpeakingPlan {
    waitSeconds: number;
    smartEndpointing: boolean;
    onPunctuationSeconds: number;
    onNoPunctuationSeconds: number;
    onNumberSeconds: number;
}

export interface StopSpeakingPlan {
    interruptionThresholdWords: number;
    interruptionThresholdSeconds: number;
    bargeInBackoffSeconds: number;
}

export interface AgentConfig {
    id: string;
    userId?: number; // Optional because system fetches don't inherently have a user context initially
    name: string;
    systemPrompt: string;
    voiceId: string;
    // LLM Settings
    llmProvider: 'groq';
    llmModel: string;
    maxTokens: number;
    temperature: number;
    // TTS Settings
    ttsProvider: 'sarvam';
    ttsModel: string;
    // Speaking Plans
    startSpeakingPlan: StartSpeakingPlan;
    stopSpeakingPlan: StopSpeakingPlan;
    createdAt: string;
    updatedAt: string;
}

export class AgentService {

    private mapDbRowToAgentConfig(row: any): AgentConfig {
        return {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            systemPrompt: row.system_prompt,
            voiceId: row.voice_id,
            llmProvider: row.llm_provider as 'groq',
            llmModel: row.llm_model,
            maxTokens: row.max_tokens,
            temperature: parseFloat(row.temperature),
            ttsProvider: row.tts_provider as 'sarvam',
            ttsModel: row.tts_model,
            startSpeakingPlan: row.start_speaking_plan as StartSpeakingPlan,
            stopSpeakingPlan: row.stop_speaking_plan as StopSpeakingPlan,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    async listAgents(userId: number): Promise<AgentConfig[]> {
        try {
            const res = await query('SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
            return res.rows.map(this.mapDbRowToAgentConfig);
        } catch (error) {
            logger.error('Failed to list agents from database', { error, userId });
            return [];
        }
    }

    // Used by API routes where user context is required
    async getAgent(id: string, userId: number): Promise<AgentConfig | undefined> {
        try {
            const res = await query('SELECT * FROM agents WHERE id = $1 AND user_id = $2', [id, userId]);
            if (res.rows.length === 0) return undefined;
            return this.mapDbRowToAgentConfig(res.rows[0]);
        } catch (error) {
            logger.error('Failed to get agent from database', { error, id, userId });
            return undefined;
        }
    }

    // Internal method used by pipelines that might not have a user request context
    async getAgentInternal(id: string): Promise<AgentConfig | undefined> {
        try {
            const res = await query('SELECT * FROM agents WHERE id = $1', [id]);
            if (res.rows.length === 0) return undefined;
            return this.mapDbRowToAgentConfig(res.rows[0]);
        } catch (error) {
            logger.error('Failed to get internal agent from database', { error, id });
            return undefined;
        }
    }

    async createAgent(userId: number, name: string, systemPrompt: string, voiceId: string, additionalConfig: Partial<AgentConfig> = {}): Promise<AgentConfig> {
        const id = uuidv4();
        const llmProvider = additionalConfig.llmProvider || 'groq';
        const llmModel = additionalConfig.llmModel || 'llama-3.3-70b-versatile';
        const maxTokens = additionalConfig.maxTokens || 150;
        const temperature = additionalConfig.temperature || 0.7;
        const ttsProvider = additionalConfig.ttsProvider || 'sarvam';
        const ttsModel = additionalConfig.ttsModel || 'bulbul:v3';

        const startSpeakingPlan = additionalConfig.startSpeakingPlan || {
            waitSeconds: 0.4,
            smartEndpointing: true,
            onPunctuationSeconds: 0.8,
            onNoPunctuationSeconds: 1.5,
            onNumberSeconds: 1.0
        };

        const stopSpeakingPlan = additionalConfig.stopSpeakingPlan || {
            interruptionThresholdWords: 2,
            interruptionThresholdSeconds: 0.5,
            bargeInBackoffSeconds: 0.5
        };

        try {
            const res = await query(
                `INSERT INTO agents (
                    id, user_id, name, system_prompt, voice_id,
                    llm_provider, llm_model, max_tokens, temperature,
                    tts_provider, tts_model, start_speaking_plan, stop_speaking_plan
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
                [
                    id, userId, name, systemPrompt, voiceId,
                    llmProvider, llmModel, maxTokens, temperature,
                    ttsProvider, ttsModel, startSpeakingPlan, stopSpeakingPlan
                ]
            );
            return this.mapDbRowToAgentConfig(res.rows[0]);
        } catch (error) {
            logger.error('Failed to create agent in database', { error, userId });
            throw error;
        }
    }

    async updateAgent(id: string, userId: number, updates: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'userId'>>): Promise<AgentConfig | undefined> {
        // Build dynamic SET clause
        const sets: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (updates.name !== undefined) { sets.push(`name = $${paramIndex++}`); values.push(updates.name); }
        if (updates.systemPrompt !== undefined) { sets.push(`system_prompt = $${paramIndex++}`); values.push(updates.systemPrompt); }
        if (updates.voiceId !== undefined) { sets.push(`voice_id = $${paramIndex++}`); values.push(updates.voiceId); }
        if (updates.llmProvider !== undefined) { sets.push(`llm_provider = $${paramIndex++}`); values.push(updates.llmProvider); }
        if (updates.llmModel !== undefined) { sets.push(`llm_model = $${paramIndex++}`); values.push(updates.llmModel); }
        if (updates.maxTokens !== undefined) { sets.push(`max_tokens = $${paramIndex++}`); values.push(updates.maxTokens); }
        if (updates.temperature !== undefined) { sets.push(`temperature = $${paramIndex++}`); values.push(updates.temperature); }
        if (updates.ttsProvider !== undefined) { sets.push(`tts_provider = $${paramIndex++}`); values.push(updates.ttsProvider); }
        if (updates.ttsModel !== undefined) { sets.push(`tts_model = $${paramIndex++}`); values.push(updates.ttsModel); }
        if (updates.startSpeakingPlan !== undefined) { sets.push(`start_speaking_plan = $${paramIndex++}`); values.push(updates.startSpeakingPlan); }
        if (updates.stopSpeakingPlan !== undefined) { sets.push(`stop_speaking_plan = $${paramIndex++}`); values.push(updates.stopSpeakingPlan); }

        if (sets.length === 0) {
            return this.getAgent(id, userId);
        }

        sets.push(`updated_at = CURRENT_TIMESTAMP`);

        values.push(id); // $paramIndex
        const idIndex = paramIndex++;
        values.push(userId); // $paramIndex
        const userIdIndex = paramIndex++;

        try {
            const res = await query(
                `UPDATE agents SET ${sets.join(', ')} WHERE id = $${idIndex} AND user_id = $${userIdIndex} RETURNING *`,
                values
            );
            if (res.rows.length === 0) return undefined;
            return this.mapDbRowToAgentConfig(res.rows[0]);
        } catch (error) {
            logger.error('Failed to update agent in database', { error, id, userId });
            throw error;
        }
    }

    async deleteAgent(id: string, userId: number): Promise<boolean> {
        try {
            const res = await query('DELETE FROM agents WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
            return res.rowCount !== null && res.rowCount > 0;
        } catch (error) {
            logger.error('Failed to delete agent from database', { error, id, userId });
            return false;
        }
    }
}

export const agentService = new AgentService();
