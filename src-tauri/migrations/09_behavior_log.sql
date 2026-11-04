-- Migration 09: behavior log for rate limiting and daily quotas.
-- Every risky browser action (friend request, like, post, parse) is recorded
-- here. The quota check is a COUNT over the current local day, and the pause
-- before the next action is derived from MAX(created_at). Keeping a log rather
-- than a counter means quotas survive restarts and can be audited per action.
CREATE TABLE IF NOT EXISTS behavior_log (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_behavior_account_action_day
    ON behavior_log(account_id, action, created_at);
