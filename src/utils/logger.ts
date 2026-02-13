import winston from 'winston';
import config from '../config';

/**
 * Production-grade logger using Winston
 */
const logger = winston.createLogger({
    level: config.app.logLevel,
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'ai-voice-agent' },
    transports: [
        // Console transport with colorized output for development
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length
                        ? `\n${JSON.stringify(meta, null, 2)}`
                        : '';
                    return `${timestamp} [${level}]: ${message}${metaStr}`;
                })
            ),
        }),
        // File transport for errors
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
        }),
        // File transport for all logs
        new winston.transports.File({
            filename: 'logs/combined.log',
        }),
    ],
});

// Create logs directory if it doesn't exist
import { mkdirSync } from 'fs';
try {
    mkdirSync('logs', { recursive: true });
} catch (err) {
    // Directory already exists
}

export default logger;
