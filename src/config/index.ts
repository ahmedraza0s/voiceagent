import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Validates that required environment variables are present
 */
function validateEnv(): void {
    const required = [
        'LIVEKIT_URL',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
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
    // LiveKit Configuration
    livekit: {
        url: process.env.LIVEKIT_URL!,
        apiKey: process.env.LIVEKIT_API_KEY!,
        apiSecret: process.env.LIVEKIT_API_SECRET!,
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
        username: process.env.SIP_USERNAME || '',
        password: process.env.SIP_PASSWORD || '',
        domain: process.env.SIP_DOMAIN || '',
        port: parseInt(process.env.SIP_PORT || '5060', 10),
        callerId: process.env.SIP_CALLER_ID || '',
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
