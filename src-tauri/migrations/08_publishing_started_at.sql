-- Migration 08: track when a post entered the 'publishing' state so posts
-- interrupted by a crash/forced exit can be recovered instead of staying
-- locked forever.
ALTER TABLE posts ADD COLUMN publishing_started_at INTEGER;
