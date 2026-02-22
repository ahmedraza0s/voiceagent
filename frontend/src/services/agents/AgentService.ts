
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger';

export interface AgentConfig {
    id: string;
    name: string;
    systemPrompt: string;
    voiceId: string;
    createdAt: string;
    updatedAt: string;
}

interface DatabaseSchema {
    agents: AgentConfig[];
    defaultInboundAgentId: string | null;
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
                agents: [],
                defaultInboundAgentId: null
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
            return { agents: [], defaultInboundAgentId: null };
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

    createAgent(name: string, systemPrompt: string, voiceId: string): AgentConfig {
        const db = this.readDb();
        const newAgent: AgentConfig = {
            id: uuidv4(),
            name,
            systemPrompt,
            voiceId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        db.agents.push(newAgent);

        // If this is the first agent, make it the default inbound
        if (db.agents.length === 1) {
            db.defaultInboundAgentId = newAgent.id;
        }

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
        };
        this.writeDb(db);
        return db.agents[index];
    }

    deleteAgent(id: string): boolean {
        const db = this.readDb();
        const initialLength = db.agents.length;
        db.agents = db.agents.filter(a => a.id !== id);

        if (db.defaultInboundAgentId === id) {
            db.defaultInboundAgentId = db.agents.length > 0 ? db.agents[0].id : null;
        }

        this.writeDb(db);
        return db.agents.length < initialLength;
    }

    setInboundAgent(id: string): boolean {
        const db = this.readDb();
        if (!db.agents.find(a => a.id === id)) return false;

        db.defaultInboundAgentId = id;
        this.writeDb(db);
        return true;
    }

    getInboundAgent(): AgentConfig | undefined {
        const db = this.readDb();
        if (!db.defaultInboundAgentId) return undefined;
        return db.agents.find(a => a.id === db.defaultInboundAgentId);
    }
}

export const agentService = new AgentService();
