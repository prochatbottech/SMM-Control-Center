use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sqlx::SqlitePool;
use crate::db;
use crate::logger;

pub const AUTOMATION_POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Invariant: Global Rate Limiter: max 1 action per minute per account
pub const MIN_ACTION_INTERVAL_SECS: i64 = 60;

/// Global Rate Limiter: Ensures an account never performs more than 1 action per 60 seconds
pub struct AutomationRateLimiter {
    last_action_by_account: Mutex<HashMap<String, i64>>,
}

impl AutomationRateLimiter {
    pub fn new() -> Self {
        Self {
            last_action_by_account: Mutex::new(HashMap::new()),
        }
    }

    pub fn can_perform_action(&self, account_id: &str, now: i64) -> bool {
        let map = self.last_action_by_account.lock().unwrap();
        if let Some(&last_ts) = map.get(account_id) {
            now - last_ts >= MIN_ACTION_INTERVAL_SECS
        } else {
            true
        }
    }

    pub fn record_action(&self, account_id: &str, now: i64) {
        let mut map = self.last_action_by_account.lock().unwrap();
        map.insert(account_id.to_string(), now);
    }
}

/// Process due automation queue tasks honoring human-like delays and the Global Rate Limiter.
pub async fn process_due_automation_tasks(
    app: Option<&tauri::AppHandle>,
    pool: &SqlitePool,
    limiter: &AutomationRateLimiter,
) -> Result<usize, String> {
    let now = chrono::Utc::now().timestamp();

    // 1. Edge Case: Mark dead leads (no interaction for 3 days) as 'cold'
    let _ = db::mark_dead_leads_as_cold(pool, 3).await;

    // 2. Fetch pending tasks ready for execution
    let due_tasks = db::get_due_automation_tasks(pool, now).await?;
    if due_tasks.is_empty() {
        return Ok(0);
    }

    let mut executed_count = 0;

    for task in due_tasks {
        // Invariant: Global Rate Limiter: max 1 action per minute per account_id
        if !limiter.can_perform_action(&task.account_id, now) {
            continue;
        }

        // Invariant: Atomic lock on queue item
        let locked = db::try_lock_queue_task(pool, &task.id).await?;
        if !locked {
            continue;
        }

        // Fetch lead and account details for logging
        let lead = db::get_lead_by_id(pool, &task.lead_id).await?;
        let lead_name = lead.as_ref().map(|l| l.name.clone()).unwrap_or_else(|| "Неизвестный лид".to_string());
        let account = db::get_account_by_id(pool, &task.account_id).await?;
        let account_name = account.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| "Аккаунт".to_string());

        // Log via UI Terminal
        logger::emit_log_opt(
            app,
            "info",
            &format!(
                "Выполняю задачу: '{}' для лида '{}' через аккаунт '{}'",
                task.action_type, lead_name, account_name
            ),
        );

        // Record action time for Rate Limiter
        limiter.record_action(&task.account_id, now);

        // Mark task as completed
        db::update_queue_task_status(pool, &task.id, "completed").await?;

        // Update lead funnel stage based on action
        if let Some(l) = lead {
            let next_stage = match task.action_type.as_str() {
                "send_friend_request" if l.funnel_stage == "new" => "request_sent",
                "send_message" if l.funnel_stage == "new" || l.funnel_stage == "request_sent" || l.funnel_stage == "request_accepted" => "aida_attention",
                "send_sticker" if l.funnel_stage == "aida_attention" => "aida_interest",
                _ => &l.funnel_stage,
            };
            let _ = db::update_lead_stage(pool, &l.id, next_stage).await;
        }

        logger::emit_log_opt(
            app,
            "success",
            &format!(
                "Задача '{}' для лида '{}' успешно выполнена",
                task.action_type, lead_name
            ),
        );

        executed_count += 1;
    }

    Ok(executed_count)
}

/// Start the background Funnel Automation Worker
/// Invariant: Non-blocking via `tauri::async_runtime::spawn`.
pub fn start_automation_worker(app: tauri::AppHandle, pool: SqlitePool) {
    tauri::async_runtime::spawn(async move {
        let limiter = Arc::new(AutomationRateLimiter::new());
        logger::emit_log(
            &app,
            "info",
            "Фоновый воркер автоматизации воронки (Local CRM) запущен",
        );

        loop {
            if let Err(e) = process_due_automation_tasks(Some(&app), &pool, &limiter).await {
                logger::emit_log(
                    &app,
                    "error",
                    &format!("Ошибка воркера автоматизации воронки: {}", e),
                );
            }
            tokio::time::sleep(AUTOMATION_POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_global_rate_limiter() {
        let limiter = AutomationRateLimiter::new();
        let account_id = "test-account-1";
        let t0 = 1000;

        // Initially can perform action
        assert!(limiter.can_perform_action(account_id, t0));

        // Record action at t0
        limiter.record_action(account_id, t0);

        // At t0 + 30s: rate limited (< 60s)
        assert!(!limiter.can_perform_action(account_id, t0 + 30));

        // Another account is NOT rate limited
        assert!(limiter.can_perform_action("test-account-2", t0 + 30));

        // At t0 + 60s: permitted
        assert!(limiter.can_perform_action(account_id, t0 + 60));
    }
}
