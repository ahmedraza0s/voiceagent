-- Migration script to create agents table
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    system_prompt TEXT NOT NULL,
    voice_id VARCHAR(50) NOT NULL,
    llm_provider VARCHAR(50) DEFAULT 'groq',
    llm_model VARCHAR(100) DEFAULT 'llama-3.3-70b-versatile',
    max_tokens INTEGER DEFAULT 150,
    temperature NUMERIC DEFAULT 0.7,
    tts_provider VARCHAR(50) DEFAULT 'sarvam',
    tts_model VARCHAR(100) DEFAULT 'bulbul:v3',
    start_speaking_plan JSONB,
    stop_speaking_plan JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
