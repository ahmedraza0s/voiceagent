import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'ai',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'Sayyed@77',
    // Connection pool settings for scalability
    max: parseInt(process.env.DB_POOL_MAX || '50'),        // Max concurrent connections
    min: parseInt(process.env.DB_POOL_MIN || '2'),         // Keep minimum warm connections
    idleTimeoutMillis: 30000,                              // Release idle connections after 30s
    connectionTimeoutMillis: 10000,                        // Fail fast if can't connect in 10s
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

export const query = (text: string, params?: any[]) => pool.query(text, params);

export default pool;
