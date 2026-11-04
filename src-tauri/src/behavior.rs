//! Behavioral throttling for browser automation.
//!
//! Anti-bot scoring reacts to *rhythm*, not to the browser fingerprint: how many
//! actions per day, and how short the gaps between them are. Everything risky is
//! therefore written to `behavior_log` and gated by a per-day quota plus a random
//! pause derived from the previous action.
//!
//! The log (rather than a counter) is the source of truth: quotas then survive
//! restarts, and a day boundary is a plain `created_at >= start_of_today` filter.

use sqlx::SqlitePool;
use uuid::Uuid;

use rand::Rng;

/// Daily limits per action kind. Values are deliberately conservative: they are
/// what a careful human does by hand, not the platform maximum.
pub fn daily_limit(action: &str) -> i64 {
    match action {
        // The single most "bot-shaped" action VK scores.
        "friend_request" => 10,
        "like" => 80,
        "post" => 5,
        "message" => 15,
        // Parsing is read-only but still costs requests and trips rate limits.
        "parse_members" => 12,
        _ => 20,
    }
}

/// Random gap between two consecutive actions of the same account, in seconds.
/// Minutes, not seconds: sub-minute regularity is the clearest machine signal.
pub fn min_gap_seconds() -> i64 {
    let mut rng = rand::thread_rng();
    rng.gen_range(180..=900)
}

/// Unix timestamp of the start of the current *local* day — the unit a human
/// operates in, and what "daily quota" must mean for the user.
fn start_of_today() -> i64 {
    use chrono::{Local, TimeZone};
    let today = Local::now().date_naive();
    today
        .and_hms_opt(0, 0, 0)
        .map(|midnight| Local.from_local_datetime(&midnight).single())
        .flatten()
        .map(|dt| dt.timestamp())
        // DST edge (a local time that does not exist): fall back to UTC midnight,
        // which is at worst one hour off and never blocks the app.
        .unwrap_or_else(|| today.and_hms_opt(0, 0, 0).map(|m| m.and_utc().timestamp()).unwrap_or(0))
}

/// How many times `action` was already performed by this account today.
pub async fn used_today(pool: &SqlitePool, account_id: &str, action: &str) -> Result<i64, String> {
    let used: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM behavior_log WHERE account_id = ? AND action = ? AND created_at >= ?",
    )
    .bind(account_id)
    .bind(action)
    .bind(start_of_today())
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to count today's actions: {}", e))?;

    Ok(used)
}

/// Remaining budget for `action` today (never negative).
pub async fn remaining_today(
    pool: &SqlitePool,
    account_id: &str,
    action: &str,
) -> Result<i64, String> {
    let used = used_today(pool, account_id, action).await?;
    Ok((daily_limit(action) - used).max(0))
}

/// Refuses the action when the daily budget is exhausted.
pub async fn ensure_quota(
    pool: &SqlitePool,
    account_id: &str,
    action: &str,
) -> Result<i64, String> {
    let limit = daily_limit(action);
    let used = used_today(pool, account_id, action).await?;

    if used >= limit {
        return Err(format!(
            "Дневной лимит «{}» исчерпан ({} из {}). Продолжите завтра — массовые действия \
             чаще одного дня подряд are the main reason accounts get limited.",
            human_action(action),
            used,
            limit
        ));
    }

    Ok(limit - used)
}

/// Records one performed action. Called *after* success: a failed attempt must
/// not consume the budget.
pub async fn record(
    pool: &SqlitePool,
    account_id: &str,
    action: &str,
    detail: Option<&str>,
) -> Result<(), String> {
    sqlx::query("INSERT INTO behavior_log (id, account_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(Uuid::new_v4().to_string())
        .bind(account_id)
        .bind(action)
        .bind(detail)
        .bind(chrono::Local::now().timestamp())
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to record behavior event: {}", e))?;

    Ok(())
}

/// Unix timestamp of this account's last logged action, if any.
pub async fn last_action_at(pool: &SqlitePool, account_id: &str) -> Result<Option<i64>, String> {
    let last: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(created_at) FROM behavior_log WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to read last action time: {}", e))?;

    Ok(last.filter(|v| *v > 0))
}

/// Sleeps until the account may act again.
///
/// The gap is randomised per call, so a queue of tasks never produces a
/// metronome. Returns the number of seconds actually waited (for logging).
pub async fn pace(pool: &SqlitePool, account_id: &str) -> Result<i64, String> {
    let Some(last) = last_action_at(pool, account_id).await? else {
        return Ok(0);
    };

    let now = chrono::Local::now().timestamp();
    let due = last + min_gap_seconds();
    let wait = due - now;

    if wait <= 0 {
        return Ok(0);
    }

    tokio::time::sleep(std::time::Duration::from_secs(wait as u64)).await;
    Ok(wait)
}

/// Short, human-readable label for quota messages.
pub fn human_action(action: &str) -> String {
    match action {
        "friend_request" => "заявки в друзья",
        "like" => "лайки",
        "post" => "публикации",
        "message" => "сообщения",
        "parse_members" => "парсинг аудитории",
        other => return other.to_string(),
    }
    .to_string()
}

/// Aggregate quota view for the UI: remaining budget per action kind.
#[derive(Debug, Clone, serde::Serialize)]
pub struct QuotaStatus {
    pub action: String,
    pub label: String,
    pub used: i64,
    pub limit: i64,
}

pub async fn quota_report(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Vec<QuotaStatus>, String> {
    let mut report = Vec::new();
    for action in ["friend_request", "like", "post", "message", "parse_members"] {
        let used = used_today(pool, account_id, action).await?;
        report.push(QuotaStatus {
            action: action.to_string(),
            label: human_action(action),
            used,
            limit: daily_limit(action),
        });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let dir = tempfile::tempdir().expect("tempdir");
        crate::db::init_db(dir.path())
            .await
            .expect("init db")
    }

    #[tokio::test]
    async fn test_quota_blocks_after_daily_limit() {
        let pool = test_pool().await;
        let account = "acc-quota-1";

        let limit = daily_limit("friend_request");
        for _ in 0..limit {
            record(&pool, account, "friend_request", Some("/id1"))
                .await
                .expect("record");
        }

        assert_eq!(remaining_today(&pool, account, "friend_request").await.unwrap(), 0);
        let err = ensure_quota(&pool, account, "friend_request")
            .await
            .expect_err("limit must be enforced");
        assert!(err.contains("исчерпан"), "unexpected message: {err}");
    }

    #[tokio::test]
    async fn test_quota_is_scoped_per_account_and_action() {
        let pool = test_pool().await;
        record(&pool, "acc-a", "friend_request", None)
            .await
            .unwrap();

        // Other action kinds and other accounts keep their full budget.
        assert_eq!(
            remaining_today(&pool, "acc-a", "like").await.unwrap(),
            daily_limit("like")
        );
        assert_eq!(
            remaining_today(&pool, "acc-b", "friend_request").await.unwrap(),
            daily_limit("friend_request")
        );
        assert_eq!(
            remaining_today(&pool, "acc-a", "friend_request").await.unwrap(),
            daily_limit("friend_request") - 1
        );
    }

    #[tokio::test]
    async fn test_pace_returns_zero_for_a_fresh_account() {
        let pool = test_pool().await;
        assert_eq!(pace(&pool, "acc-never-acted").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn test_pace_waits_after_a_recent_action() {
        let pool = test_pool().await;
        let account = "acc-paced";
        record(&pool, account, "like", None).await.unwrap();

        // The action just happened, so the random 180..900s gap cannot have
        // elapsed; waiting the full budget would hang the test, so only assert
        // that a wait is scheduled without actually sleeping.
        let last = last_action_at(&pool, account).await.unwrap().expect("recorded");
        let now = chrono::Local::now().timestamp();
        assert!(last + min_gap_seconds() > now, "a fresh action must pace");
    }

    #[test]
    fn test_start_of_today_is_before_now() {
        let start = start_of_today();
        let now = chrono::Local::now().timestamp();
        assert!(start <= now);
        assert!(now - start < 86_400, "start of day must be within the last 24h");
    }
}
