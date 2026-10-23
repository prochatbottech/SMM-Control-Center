-- Migration 06: account auth metadata + publishing target (community/channel/group)
ALTER TABLE accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'oauth';
ALTER TABLE accounts ADD COLUMN target_id TEXT;
ALTER TABLE accounts ADD COLUMN target_title TEXT;
ALTER TABLE accounts ADD COLUMN owner_external_id TEXT;
