import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger';
import { query } from '../../database/db';

export interface SipSettings {
    id: string;
    userId?: number;
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

export class SipSettingsService {

    private mapDbRowToSipSettings(row: any): SipSettings {
        return {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            username: row.username,
            password: row.password,
            domain: row.domain,
            port: row.port,
            callerId: row.caller_id,
            proxy: row.proxy,
            inboundAgentId: row.inbound_agent_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    async listSettings(userId?: number): Promise<SipSettings[]> {
        try {
            if (userId !== undefined) {
                // Fetch only settings for the specific user (used by frontend/API)
                const res = await query('SELECT * FROM sip_settings WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
                return res.rows.map(this.mapDbRowToSipSettings);
            } else {
                // Fetch all settings globally (used by FreeSWITCH initialization/routing)
                const res = await query('SELECT * FROM sip_settings ORDER BY created_at DESC');
                return res.rows.map(this.mapDbRowToSipSettings);
            }
        } catch (error) {
            logger.error('Failed to list SIP settings from database', { error, userId });
            return [];
        }
    }

    async getSettings(id: string, userId?: number): Promise<SipSettings | undefined> {
        try {
            let res;
            if (userId !== undefined) {
                res = await query('SELECT * FROM sip_settings WHERE id = $1 AND user_id = $2', [id, userId]);
            } else {
                res = await query('SELECT * FROM sip_settings WHERE id = $1', [id]);
            }

            if (res.rows.length === 0) return undefined;
            return this.mapDbRowToSipSettings(res.rows[0]);
        } catch (error) {
            logger.error('Failed to get SIP settings from database', { error, id, userId });
            return undefined;
        }
    }

    /**
     * Find a SIP setting matching an inbound SIP To: header.
     * Queries DB directly with index — O(log n), not O(n) full table scan.
     * Used exclusively for inbound call routing (no userId needed).
     */
    async findByToHeader(toHeader: string): Promise<SipSettings | undefined> {
        try {
            const res = await query(
                `SELECT * FROM sip_settings
                 WHERE $1 LIKE '%' || username || '%'
                    OR (caller_id IS NOT NULL AND $1 LIKE '%' || caller_id || '%')
                 LIMIT 1`,
                [toHeader]
            );
            if (res.rows.length === 0) return undefined;
            return this.mapDbRowToSipSettings(res.rows[0]);
        } catch (error) {
            logger.error('Failed to find SIP settings by To header', { error, toHeader });
            return undefined;
        }
    }

    async createSettings(userId: number, settings: Omit<SipSettings, 'id' | 'createdAt' | 'updatedAt' | 'userId'>): Promise<SipSettings> {
        const id = uuidv4();
        try {
            const res = await query(
                `INSERT INTO sip_settings (
                    id, user_id, name, username, password, domain, port, caller_id, proxy, inbound_agent_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [
                    id, userId, settings.name, settings.username, settings.password,
                    settings.domain, settings.port, settings.callerId, settings.proxy, settings.inboundAgentId || null
                ]
            );
            return this.mapDbRowToSipSettings(res.rows[0]);
        } catch (error) {
            logger.error('Failed to create SIP settings in database', { error, userId });
            throw error;
        }
    }

    async updateSettings(id: string, userId: number, updates: Partial<Omit<SipSettings, 'id' | 'createdAt' | 'userId'>>): Promise<SipSettings | undefined> {
        const sets: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (updates.name !== undefined) { sets.push(`name = $${paramIndex++}`); values.push(updates.name); }
        if (updates.username !== undefined) { sets.push(`username = $${paramIndex++}`); values.push(updates.username); }
        if (updates.password !== undefined) { sets.push(`password = $${paramIndex++}`); values.push(updates.password); }
        if (updates.domain !== undefined) { sets.push(`domain = $${paramIndex++}`); values.push(updates.domain); }
        if (updates.port !== undefined) { sets.push(`port = $${paramIndex++}`); values.push(updates.port); }
        if (updates.callerId !== undefined) { sets.push(`caller_id = $${paramIndex++}`); values.push(updates.callerId); }
        if (updates.proxy !== undefined) { sets.push(`proxy = $${paramIndex++}`); values.push(updates.proxy); }
        if (updates.inboundAgentId !== undefined) { sets.push(`inbound_agent_id = $${paramIndex++}`); values.push(updates.inboundAgentId || null); }

        if (sets.length === 0) {
            return this.getSettings(id, userId);
        }

        sets.push(`updated_at = CURRENT_TIMESTAMP`);

        values.push(id);
        const idIndex = paramIndex++;
        values.push(userId);
        const userIdIndex = paramIndex++;

        try {
            const res = await query(
                `UPDATE sip_settings SET ${sets.join(', ')} WHERE id = $${idIndex} AND user_id = $${userIdIndex} RETURNING *`,
                values
            );
            if (res.rows.length === 0) return undefined;
            return this.mapDbRowToSipSettings(res.rows[0]);
        } catch (error) {
            logger.error('Failed to update SIP settings in database', { error, id, userId });
            throw error;
        }
    }

    async deleteSettings(id: string, userId: number): Promise<boolean> {
        try {
            const res = await query('DELETE FROM sip_settings WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
            return res.rowCount !== null && res.rowCount > 0;
        } catch (error) {
            logger.error('Failed to delete SIP settings from database', { error, id, userId });
            return false;
        }
    }
}

export const sipSettingsService = new SipSettingsService();
