-- Migration 05: Add post format (regular post vs rich article for Telegram)
ALTER TABLE posts ADD COLUMN format TEXT NOT NULL DEFAULT 'post';
