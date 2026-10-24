-- Audience contacts parsed from social networks via browser automation.
CREATE TABLE IF NOT EXISTS audience_contacts (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    source TEXT,
    profile_href TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audience_unique
    ON audience_contacts(account_id, profile_href);

CREATE INDEX IF NOT EXISTS idx_audience_status
    ON audience_contacts(status);
