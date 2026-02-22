
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger';

export interface SipSettings {
    id: string;
    name: string;
    username: string;
    password?: string;
    domain: string;
    port: number;
    callerId: string;
    proxy?: string;
    inboundAgentId?: string; // Tying an agent to this number
    createdAt: string;
    updatedAt: string;
}

interface DatabaseSchema {
    sipSettings: SipSettings[];
}

export class SipSettingsService {
    private dbPath: string;

    constructor() {
        this.dbPath = path.join(__dirname, '../../database/sip_settings.json');
        this.ensureDatabaseExists();
    }

    private ensureDatabaseExists() {
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        if (!fs.existsSync(this.dbPath)) {
            const initialDb: DatabaseSchema = {
                sipSettings: []
            };
            fs.writeFileSync(this.dbPath, JSON.stringify(initialDb, null, 2));
        }
    }

    private readDb(): DatabaseSchema {
        try {
            const data = fs.readFileSync(this.dbPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            logger.error('Failed to read SIP settings database', { error });
            return { sipSettings: [] };
        }
    }

    private writeDb(db: DatabaseSchema) {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(db, null, 2));
        } catch (error) {
            logger.error('Failed to write SIP settings database', { error });
        }
    }

    listSettings(): SipSettings[] {
        return this.readDb().sipSettings;
    }

    getSettings(id: string): SipSettings | undefined {
        return this.readDb().sipSettings.find(s => s.id === id);
    }

    createSettings(settings: Omit<SipSettings, 'id' | 'createdAt' | 'updatedAt'>): SipSettings {
        const db = this.readDb();
        const newSettings: SipSettings = {
            ...settings,
            id: uuidv4(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        db.sipSettings.push(newSettings);
        this.writeDb(db);
        return newSettings;
    }

    updateSettings(id: string, updates: Partial<Omit<SipSettings, 'id' | 'createdAt'>>): SipSettings | undefined {
        const db = this.readDb();
        const index = db.sipSettings.findIndex(s => s.id === id);
        if (index === -1) return undefined;

        db.sipSettings[index] = {
            ...db.sipSettings[index],
            ...updates,
            updatedAt: new Date().toISOString()
        };
        this.writeDb(db);
        return db.sipSettings[index];
    }

    deleteSettings(id: string): boolean {
        const db = this.readDb();
        const initialLength = db.sipSettings.length;
        db.sipSettings = db.sipSettings.filter(s => s.id !== id);
        this.writeDb(db);
        return db.sipSettings.length < initialLength;
    }
}

export const sipSettingsService = new SipSettingsService();
