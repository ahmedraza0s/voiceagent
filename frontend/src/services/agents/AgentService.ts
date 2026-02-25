
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger';

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

interface DatabaseSchema {
    agents: AgentConfig[];
}

export class AgentService {
    private dbPath: string;

    constructor() {
        this.dbPath = path.join(__dirname, '../../database/agents.json');
        this.ensureDatabaseExists();
    }

    private ensureDatabaseExists() {
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        if (!fs.existsSync(this.dbPath)) {
            const initialDb: DatabaseSchema = {
                agents: []
            };
            fs.writeFileSync(this.dbPath, JSON.stringify(initialDb, null, 2));
        }
    }

    private readDb(): DatabaseSchema {
        try {
            const data = fs.readFileSync(this.dbPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            logger.error('Failed to read agents database', { error });
            return { agents: [] };
        }
    }

    private writeDb(db: DatabaseSchema) {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(db, null, 2));
        } catch (error) {
            logger.error('Failed to write agents database', { error });
        }
    }

    listAgents(): AgentConfig[] {
        return this.readDb().agents;
    }

    getAgent(id: string): AgentConfig | undefined {
        return this.readDb().agents.find(a => a.id === id);
    }

    createAgent(name: string, systemPrompt: string, voiceId: string, additionalConfig: Partial<AgentConfig> = {}): AgentConfig {
        const db = this.readDb();
        const newAgent: AgentConfig = {
            id: uuidv4(),
            name,
            systemPrompt,
            voiceId,
            llmProvider: additionalConfig.llmProvider || 'groq',
            llmModel: additionalConfig.llmModel || 'llama-3.3-70b-versatile',
            maxTokens: additionalConfig.maxTokens || 150,
            temperature: additionalConfig.temperature || 0.7,
            ttsProvider: additionalConfig.ttsProvider || 'sarvam',
            ttsModel: additionalConfig.ttsModel || 'bulbul:v3',
            startSpeakingPlan: additionalConfig.startSpeakingPlan || {
                waitSeconds: 0.4,
                smartEndpointing: true,
                onPunctuationSeconds: 0.8,
                onNoPunctuationSeconds: 1.5,
                onNumberSeconds: 1.0
            },
            stopSpeakingPlan: additionalConfig.stopSpeakingPlan || {
                interruptionThresholdWords: 2,
                interruptionThresholdSeconds: 0.5,
                bargeInBackoffSeconds: 0.5
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        db.agents.push(newAgent);

        this.writeDb(db);
        return newAgent;
    }

    updateAgent(id: string, updates: Partial<Omit<AgentConfig, 'id' | 'createdAt'>>): AgentConfig | undefined {
        const db = this.readDb();
        const index = db.agents.findIndex(a => a.id === id);
        if (index === -1) return undefined;

        db.agents[index] = {
            ...db.agents[index],
            ...updates,
            updatedAt: new Date().toISOString()
        } as AgentConfig;
        this.writeDb(db);
        return db.agents[index];
    }

    deleteAgent(id: string): boolean {
        const db = this.readDb();
        const initialLength = db.agents.length;
        db.agents = db.agents.filter(a => a.id !== id);

        this.writeDb(db);
        return db.agents.length < initialLength;
    }
}

export const agentService = new AgentService();
