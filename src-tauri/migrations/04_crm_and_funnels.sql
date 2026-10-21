-- Migration 04: Local CRM (Leads) and Funnel Automation Queue
CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('vk', 'tg', 'ok')),
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    funnel_stage TEXT NOT NULL DEFAULT 'new',
    last_interaction_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_platform_external_id ON leads(platform, external_id);
CREATE INDEX IF NOT EXISTS idx_leads_funnel_stage ON leads(funnel_stage);

CREATE TABLE IF NOT EXISTS automation_queue (
    id TEXT PRIMARY KEY NOT NULL,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL CHECK(action_type IN ('send_friend_request', 'send_message', 'send_sticker', 'check_status')),
    payload TEXT NOT NULL,
    execute_after INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_queue_status_execute ON automation_queue(status, execute_after);
CREATE INDEX IF NOT EXISTS idx_automation_queue_account ON automation_queue(account_id);
