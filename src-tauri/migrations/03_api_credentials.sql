-- Migration: Create api_credentials table for LLM API keys
CREATE TABLE IF NOT EXISTS api_credentials (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('openai_compat', 'anthropic')),
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_provider ON api_credentials(provider);
