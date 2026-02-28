import fs from 'fs';
import path from 'path';
import { query } from './db';

async function runMigration() {
    try {
        const sql = fs.readFileSync(path.join(__dirname, 'migration.sql'), 'utf8');
        await query(sql);
        console.log('Migration successful');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

runMigration();
