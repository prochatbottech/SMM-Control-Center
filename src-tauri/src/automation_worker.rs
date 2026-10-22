use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sqlx::SqlitePool;
use zeroize::Zeroizing;
use crate::crm_connectors;
use crate::crypto;
use crate::db;
use crate::logger;
use crate::worker_status;

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
    let connector = crm_connectors::RealCrmConnector::new();
    process_due_automation_tasks_with_connector(app, pool, limiter, &connector, None).await
}

/// Core processor with configurable connector and optional master key override for tests
pub async fn process_due_automation_tasks_with_connector<C: crm_connectors::CrmConnector>(
    app: Option<&tauri::AppHandle>,
    pool: &SqlitePool,
    limiter: &AutomationRateLimiter,
    connector: &C,
    override_master_key: Option<[u8; 32]>,
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

        // Fetch lead details
        let maybe_lead = db::get_lead_by_id(pool, &task.lead_id).await?;
        let lead = match maybe_lead {
            Some(l) => l,
            None => {
                logger::emit_log_opt(
                    app,
                    "error",
                    &format!("Лид с ID '{}' не найден в базе. Задача отменена.", task.lead_id),
                );
                let _ = db::update_queue_task_status(pool, &task.id, "failed").await;
                continue;
            }
        };

        // Fetch account details
        let maybe_account = db::get_account_by_id(pool, &task.account_id).await?;
        let account = match maybe_account {
            Some(a) => a,
            None => {
                logger::emit_log_opt(
                    app,
                    "error",
                    &format!("Аккаунт с ID '{}' не найден в базе. Задача отменена.", task.account_id),
                );
                let _ = db::update_queue_task_status(pool, &task.id, "failed").await;
                continue;
            }
        };

        let lead_name = lead.name.clone();
        let account_name = account.name.clone();

        // Invariant: Zero-Secret Execution: Decrypt token right before HTTP request and zeroize memory on drop
        let master_key = match override_master_key {
            Some(k) => k,
            None => match crypto::get_or_generate_key() {
                Ok(k) => k,
                Err(e) => {
                    let err_msg = format!("Ошибка доступа к master key: {}", e);
                    logger::emit_log_opt(app, "error", &err_msg);
                    let _ = db::update_queue_task_status(pool, &task.id, "failed").await;
                    continue;
                }
            },
        };

        let decrypted_token = match crypto::decrypt_token(&account.encrypted_token, &master_key) {
            Ok(t) => t,
            Err(e) => {
                let err_msg = format!("Ошибка дешифрования токена аккаунта: {}", e);
                logger::emit_log_opt(app, "error", &err_msg);
                let _ = db::update_queue_task_status(pool, &task.id, "failed").await;
                continue;
            }
        };
        let raw_token = Zeroizing::new(decrypted_token);

        // Log action start in UI Terminal
        logger::emit_log_opt(
            app,
            "info",
            &format!(
                "Выполняю задачу: '{}' для лида '{}' ({}) через аккаунт '{}'",
                task.action_type, lead_name, lead.external_id, account_name
            ),
        );

        // Record action time for Rate Limiter (enforces anti-ban throttle regardless of outcome)
        limiter.record_action(&task.account_id, now);

        // Execute platform-specific network connector via trait
        let exec_result = connector
            .execute_action(
                &account.platform,
                &raw_token,
                &lead.external_id,
                &task.action_type,
                &task.payload,
            )
            .await;

        match exec_result {
            Ok(result_info) => {
                // Invariant: Mark completed
                db::update_queue_task_status(pool, &task.id, "completed").await?;

                // Invariant: Обновление состояния Лида:
                // - При send_friend_request -> обновить leads.funnel_stage на request_sent
                // - При send_message -> обновить leads.last_interaction_at на текущий now()
                match task.action_type.as_str() {
                    "send_friend_request" => {
                        let _ = db::update_lead_stage(pool, &lead.id, "request_sent").await;
                    }
                    "send_message" => {
                        let _ = db::update_lead_interaction(pool, &lead.id, now).await;
                        if lead.funnel_stage == "new"
                            || lead.funnel_stage == "request_sent"
                            || lead.funnel_stage == "request_accepted"
                        {
                            let _ = db::update_lead_stage(pool, &lead.id, "aida_attention").await;
                        }
                    }
                    "send_sticker" => {
                        let _ = db::update_lead_interaction(pool, &lead.id, now).await;
                        if lead.funnel_stage == "aida_attention" {
                            let _ = db::update_lead_stage(pool, &lead.id, "aida_interest").await;
                        }
                    }
                    _ => {
                        let _ = db::update_lead_interaction(pool, &lead.id, now).await;
                    }
                }

                logger::emit_log_opt(
                    app,
                    "success",
                    &format!(
                        "Задача '{}' для лида '{}' успешно выполнена ({})",
                        task.action_type, lead_name, result_info
                    ),
                );

                executed_count += 1;
            }
            Err(err_msg) => {
                // Invariant: Защита от Капчи и Бан-шторма:
                // Ошибки (капча 14, приватность 901, валидация 17 и др.) немедленно переводят задачу в 'failed'
                db::update_queue_task_status(pool, &task.id, "failed").await?;

                logger::emit_log_opt(
                    app,
                    "error",
                    &format!(
                        "Задача '{}' для лида '{}' ({}) завершилась ошибкой: {}",
                        task.action_type, lead_name, lead.external_id, err_msg
                    ),
                );
            }
        }
    }

    Ok(executed_count)
}

/// Start the background Funnel Automation Worker
/// Invariant: Non-blocking via `tauri::async_runtime::spawn`.
pub fn start_automation_worker(app: tauri::AppHandle, pool: SqlitePool) {
    tauri::async_runtime::spawn(async move {
        let limiter = Arc::new(AutomationRateLimiter::new());
        worker_status::automation_set_running();
        logger::emit_log(
            &app,
            "info",
            "Фоновый воркер автоматизации воронки (Local CRM) запущен",
        );

        loop {
            match process_due_automation_tasks(Some(&app), &pool, &limiter).await {
                Ok(count) => worker_status::automation_record_iteration(count),
                Err(e) => {
                    logger::emit_log(
                        &app,
                        "error",
                        &format!("Ошибка воркера автоматизации воронки: {}", e),
                    );
                }
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

    #[tokio::test]
    async fn test_worker_marks_task_failed_on_api_error() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();

        sqlx::query(crate::db::MIGRATION_01_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_02_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_03_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_04_SQL).execute(&pool).await.unwrap();

        let test_master_key = [99u8; 32];
        let enc_token = crypto::encrypt_token("vk_token", &test_master_key).unwrap();

        let acc = db::create_account(
            &pool,
            crate::models::CreateAccountInput {
                id: None,
                platform: "vk".to_string(),
                name: "VK Bot".to_string(),
                encrypted_token: enc_token,
                created_at: None,
            },
        )
        .await
        .unwrap();

        let lead = db::add_lead(
            &pool,
            crate::models::CreateLeadInput {
                id: None,
                platform: "vk".to_string(),
                external_id: "id999999".to_string(),
                name: "Блокирующий Лид".to_string(),
                funnel_stage: Some("new".to_string()),
                last_interaction_at: None,
                created_at: None,
            },
        )
        .await
        .unwrap();

        let past = chrono::Utc::now().timestamp() - 5;
        let task = db::add_queue_item(
            &pool,
            None,
            &lead.id,
            &acc.id,
            "send_friend_request",
            "{}",
            past,
        )
        .await
        .unwrap();

        struct FailingCrmConnector;
        impl crm_connectors::CrmConnector for FailingCrmConnector {
            async fn execute_action(
                &self,
                _platform: &str,
                _token: &str,
                _external_id: &str,
                _action_type: &str,
                _payload: &str,
            ) -> Result<String, String> {
                Err("VK API error 14: Captcha needed".to_string())
            }
        }

        let limiter = AutomationRateLimiter::new();
        let executed = process_due_automation_tasks_with_connector(
            None,
            &pool,
            &limiter,
            &FailingCrmConnector,
            Some(test_master_key),
        )
        .await
        .unwrap();

        assert_eq!(executed, 0, "Failing task must not count as successful execution");

        let tasks = db::get_automation_queue(&pool).await.unwrap();
        let failed_task = tasks.iter().find(|t| t.id == task.id).unwrap();
        assert_eq!(failed_task.status, "failed");

        let lead_after = db::get_lead_by_id(&pool, &lead.id).await.unwrap().unwrap();
        assert_eq!(lead_after.funnel_stage, "new");
    }

    #[tokio::test]
    async fn test_worker_updates_lead_interaction_and_advances_stage_on_message() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();

        sqlx::query(crate::db::MIGRATION_01_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_02_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_03_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_04_SQL).execute(&pool).await.unwrap();

        let test_master_key = [88u8; 32];
        let enc_token = crypto::encrypt_token("tg_bot_token", &test_master_key).unwrap();

        let acc = db::create_account(
            &pool,
            crate::models::CreateAccountInput {
                id: None,
                platform: "tg".to_string(),
                name: "TG Sales Bot".to_string(),
                encrypted_token: enc_token,
                created_at: None,
            },
        )
        .await
        .unwrap();

        let lead = db::add_lead(
            &pool,
            crate::models::CreateLeadInput {
                id: None,
                platform: "tg".to_string(),
                external_id: "@customer_chat".to_string(),
                name: "Заказчик".to_string(),
                funnel_stage: Some("new".to_string()),
                last_interaction_at: None,
                created_at: None,
            },
        )
        .await
        .unwrap();

        let past = chrono::Utc::now().timestamp() - 5;
        let task = db::add_queue_item(
            &pool,
            None,
            &lead.id,
            &acc.id,
            "send_message",
            r#"{"text":"Привет, готов обсудить проект?"}"#,
            past,
        )
        .await
        .unwrap();

        struct SuccessCrmConnector;
        impl crm_connectors::CrmConnector for SuccessCrmConnector {
            async fn execute_action(
                &self,
                _platform: &str,
                _token: &str,
                _external_id: &str,
                _action_type: &str,
                _payload: &str,
            ) -> Result<String, String> {
                Ok("msg_123456".to_string())
            }
        }

        let limiter = AutomationRateLimiter::new();
        let executed = process_due_automation_tasks_with_connector(
            None,
            &pool,
            &limiter,
            &SuccessCrmConnector,
            Some(test_master_key),
        )
        .await
        .unwrap();

        assert_eq!(executed, 1);

        let tasks = db::get_automation_queue(&pool).await.unwrap();
        let completed_task = tasks.iter().find(|t| t.id == task.id).unwrap();
        assert_eq!(completed_task.status, "completed");

        let lead_after = db::get_lead_by_id(&pool, &lead.id).await.unwrap().unwrap();
        assert_eq!(lead_after.funnel_stage, "aida_attention");
        assert!(lead_after.last_interaction_at.is_some());
    }
}
