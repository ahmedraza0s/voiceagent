import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Validates that required environment variables are present
 */
function validateEnv(): void {
    const required = [
        'DEEPGRAM_API_KEY',
        'GROQ_API_KEY',
        'SARVAM_API_KEY',
    ];

    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}`
        );
    }
}

// Validate on module load
validateEnv();

/**
 * Application configuration loaded from environment variables
 */
export const config = {
    // FreeSWITCH ESL Configuration
    freeswitch: {
        host: process.env.FREESWITCH_HOST || '127.0.0.1',
        port: parseInt(process.env.FREESWITCH_PORT || '8021', 10),
        password: process.env.FREESWITCH_PASSWORD || 'ClueCon',
        sipGateway: process.env.FREESWITCH_SIP_GATEWAY || 'vivphone',
    },

    // Deepgram Configuration (STT)
    deepgram: {
        apiKey: process.env.DEEPGRAM_API_KEY!,
    },

    // Groq Configuration (LLM)
    groq: {
        apiKey: process.env.GROQ_API_KEY!,
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    },

    // Sarvam.ai Configuration (TTS)
    sarvam: {
        apiKey: process.env.SARVAM_API_KEY!,
    },

    // SIP Configuration
    sip: {
        inbound: {
            username: process.env.SIP_INBOUND_USERNAME || process.env.SIP_USERNAME || '',
            password: process.env.SIP_INBOUND_PASSWORD || process.env.SIP_PASSWORD || '',
            domain: process.env.SIP_INBOUND_DOMAIN || process.env.SIP_DOMAIN || '',
            port: parseInt(process.env.SIP_INBOUND_PORT || process.env.SIP_PORT || '5060', 10),
            proxy: process.env.SIP_INBOUND_PROXY || '',
        },
        outbound: {
            username: process.env.SIP_OUTBOUND_USERNAME || process.env.SIP_USERNAME || '',
            password: process.env.SIP_OUTBOUND_PASSWORD || process.env.SIP_PASSWORD || '',
            domain: process.env.SIP_OUTBOUND_DOMAIN || process.env.SIP_DOMAIN || '',
            port: parseInt(process.env.SIP_OUTBOUND_PORT || process.env.SIP_PORT || '5060', 10),
            callerId: process.env.SIP_OUTBOUND_CALLER_ID || process.env.SIP_CALLER_ID || '',
        },
    },

    // Application Configuration
    app: {
        port: parseInt(process.env.PORT || '3000', 10),
        nodeEnv: process.env.NODE_ENV || 'development',
        logLevel: process.env.LOG_LEVEL || 'info',
    },

    // System Prompt for AI Assistant
    systemPrompt: `You are a professional AI voice assistant speaking on live phone calls.
Keep responses short (1–3 sentences).
Speak naturally and conversationally.
Never mention you are an AI.
If interrupted, stop speaking immediately and respond to the user.
If this is a business call, collect name, phone number, and requirement.`,
} as const;

export default config;
