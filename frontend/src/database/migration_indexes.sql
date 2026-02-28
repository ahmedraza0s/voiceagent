-- Add performance indexes for user-scoped queries
-- These prevent full table scans on large datasets

CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_created_at ON agents(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sip_settings_user_id ON sip_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_sip_settings_created_at ON sip_settings(created_at DESC);
