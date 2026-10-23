pub mod analytics;
pub mod automation_worker;
pub mod backup;
pub mod commands;
pub mod crm;
pub mod crm_connectors;
pub mod crypto;
pub mod db;
pub mod funnel_prompts;
pub mod llm_gateway;
pub mod logger;
pub mod models;
pub mod parser;
pub mod publisher;
pub mod scheduler;
pub mod worker_status;
pub mod vk_oauth;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Define migrations for tauri-plugin-sql
    let _migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: db::MIGRATION_01_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_destinations_status_and_logs",
            sql: db::MIGRATION_02_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_api_credentials_table",
            sql: db::MIGRATION_03_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create_crm_and_funnels_tables",
            sql: db::MIGRATION_04_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_post_format",
            sql: db::MIGRATION_05_SQL,
            kind: MigrationKind::Up,
        },
    ];

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(
            tauri_plugin_sql::Builder::default()
                // plugin checksum migrations disabled: schema is managed by db.rs::apply_migrations
                .build(),
        )
        .setup(|app| {
            // Invariant: Database must reside in app_data_dir
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to resolve app_data_dir: {}", e))?;

            // Initialize database pool with foreign keys and WAL mode
            let pool = tauri::async_runtime::block_on(async {
                db::init_db(&app_data_dir).await
            })
            .map_err(|e| format!("Database initialization failed: {}", e))?;

            // Invariant: Start background scheduler worker non-blocking via tokio::spawn
            scheduler::start_worker(app.handle().clone(), pool.clone());

            // Invariant: Start background CRM Funnel Automation worker
            automation_worker::start_automation_worker(app.handle().clone(), pool.clone());

            // Manage DbState for Tauri commands
            app.manage(db::DbState { pool });

            // Invariant: Silent Autostart check
            let is_autostart = std::env::args().any(|arg| {
                arg == "--autostart" || arg == "--silent" || arg == "--minimized"
            });
            if let Some(window) = app.get_webview_window("main") {
                if is_autostart {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            }

            // Invariant: System Tray Menu setup
            let show_item = MenuItem::with_id(
                app,
                "show",
                "Развернуть SMM Control Center",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let _tray = tray_builder.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_account,
            commands::get_accounts,
            commands::get_account_by_id,
            commands::delete_account,
            commands::vk_list_communities,
            commands::set_account_target,
            vk_oauth::vk_oauth_start,
            vk_oauth::vk_oauth_complete,
            commands::create_post,
            commands::get_posts,
            commands::delete_post,
            commands::retry_post,
            commands::parse_content_source,
            commands::create_api_credential,
            commands::get_api_credentials,
            commands::delete_api_credential,
            commands::generate_ai_rewrite,
            crm::add_lead,
            crm::get_leads,
            crm::update_lead_stage,
            crm::delete_lead,
            crm::schedule_action,
            crm::get_automation_queue,
            crm::delete_queue_item,
            crm::mark_dead_leads,
            crm::generate_funnel_message,
            crm::generate_and_schedule_message,
            analytics::get_funnel_analytics,
            backup::export_database,
            backup::import_database,
            worker_status::get_worker_status
        ]);

    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(not(debug_assertions))]
    {
        context.config_mut().build.dev_url = None;
    }

    let app = builder
        .build(context)
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            label,
            ..
        } => {
            // Invariant: Background Worker Survival. Window hides on close, Tokio worker keeps running.
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window(&label) {
                let _ = window.hide();
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            // Prevent application from exiting when all windows are hidden
            api.prevent_exit();
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use models::{CreateAccountInput, CreatePostInput};
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_init_db_and_foreign_keys_enabled() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        // Verify foreign_keys pragma is ON
        let fk_enabled: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .expect("Failed to query PRAGMA foreign_keys");
        assert_eq!(fk_enabled, 1, "PRAGMA foreign_keys must be ON");
    }

    #[tokio::test]
    async fn test_accounts_crud_and_cascade_delete() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        // 1. Create account
        let acc_input = CreateAccountInput {
            id: None,
            platform: "vk".to_string(),
            name: "VK Community".to_string(),
            encrypted_token: "encrypted_token_sample".to_string(),
            created_at: None,
        };
        let created_acc = db::create_account(&pool, acc_input)
            .await
            .expect("Failed to create account");
        assert_eq!(created_acc.platform, "vk");
        assert_eq!(created_acc.name, "VK Community");

        // 2. Fetch accounts
        let accounts = db::get_accounts(&pool).await.expect("Failed to fetch accounts");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, created_acc.id);

        // 3. Create post targeting this account
        let post_input = CreatePostInput {
            id: None,
            content: "Hello World Post".to_string(),
            media_urls: Some(vec!["https://example.com/img.png".to_string()]),
            status: Some("draft".to_string()),
            scheduled_for: None,
            created_at: None,
            format: None,
            destination_account_ids: Some(vec![created_acc.id.clone()]),
        };
        let created_post = db::create_post(&pool, post_input)
            .await
            .expect("Failed to create post");
        assert_eq!(created_post.destination_account_ids.len(), 1);

        // Verify destination exists in post_destinations
        let count_dest: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM post_destinations WHERE post_id = ? AND account_id = ?"
        )
        .bind(&created_post.id)
        .bind(&created_acc.id)
        .fetch_one(&pool)
        .await
        .expect("Query failed");
        assert_eq!(count_dest, 1);

        // 4. Invariant test: Delete account -> Cascade delete in post_destinations
        let deleted = db::delete_account(&pool, &created_acc.id)
            .await
            .expect("Failed to delete account");
        assert!(deleted);

        // Verify destination was deleted by CASCADE
        let count_dest_after: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM post_destinations WHERE account_id = ?"
        )
        .bind(&created_acc.id)
        .fetch_one(&pool)
        .await
        .expect("Query failed");
        assert_eq!(count_dest_after, 0, "Record in post_destinations should be cascaded on account deletion");

        // The post itself still exists
        let posts = db::get_posts(&pool).await.expect("Failed to get posts");
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].destination_account_ids.len(), 0);
    }

    #[tokio::test]
    async fn test_foreign_key_constraint_violation() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        let fake_account_id = uuid::Uuid::new_v4().to_string();
        let post_input = CreatePostInput {
            id: None,
            content: "Post for non-existent account".to_string(),
            media_urls: None,
            status: Some("draft".to_string()),
            scheduled_for: None,
            created_at: None,
            format: None,
            destination_account_ids: Some(vec![fake_account_id]),
        };

        // Should fail due to foreign key violation
        let res = db::create_post(&pool, post_input).await;
        assert!(res.is_err(), "Must fail when destination account doesn't exist");
    }

    #[test]
    fn test_frontend_isolation_token_omitted_from_serialization() {
        let account = models::Account {
            id: "12345678-1234-1234-1234-123456789abc".to_string(),
            platform: "vk".to_string(),
            name: "VK Group".to_string(),
            encrypted_token: "super_secret_encrypted_payload".to_string(),
            created_at: 1729440000,
            auth_type: Some("oauth".to_string()),
            target_id: None,
            target_title: None,
            owner_external_id: None,
            masked_token: None,
        }
        .with_masked_token();

        let json_val = serde_json::to_value(&account).expect("Must serialize");
        let obj = json_val.as_object().expect("Must be a JSON object");

        // Invariant: encrypted_token MUST NOT be present in JSON
        assert!(
            !obj.contains_key("encrypted_token"),
            "Sensitive token must be omitted via #[serde(skip_serializing)]"
        );
        // Masked token is provided
        assert_eq!(
            obj.get("masked_token").and_then(|v| v.as_str()),
            Some("vk_***1234")
        );
    }

    #[tokio::test]
    async fn test_encrypted_token_flow_with_keyring_and_db() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        let raw_token = "vk1.a.secret_test_token_1234567890";
        let master_key = match crypto::get_or_generate_key() {
            Ok(key) => key,
            Err(crypto::CryptoError::KeyringUnavailable(_)) => [42u8; 32],
            Err(e) => panic!("Unexpected crypto error: {:?}", e),
        };

        // 1. Encrypt raw token before saving
        let encrypted = crypto::encrypt_token(raw_token, &master_key).expect("Encryption failed");
        assert!(encrypted.contains(':'), "Encrypted token must have Base64(Nonce):Base64(Ciphertext)");

        let acc_input = CreateAccountInput {
            id: None,
            platform: "vk".to_string(),
            name: "Encrypted VK".to_string(),
            encrypted_token: encrypted.clone(),
            created_at: None,
        };

        let created = db::create_account(&pool, acc_input).await.expect("Save failed");

        // 2. Query directly from SQLite
        let raw_db_token: String = sqlx::query_scalar("SELECT encrypted_token FROM accounts WHERE id = ?")
            .bind(&created.id)
            .fetch_one(&pool)
            .await
            .expect("Fetch failed");

        assert_eq!(raw_db_token, encrypted, "Raw token in DB must match encrypted payload");
        assert_ne!(raw_db_token, raw_token, "Raw token in DB must NEVER be plain-text");

        // 3. Decrypt back using master key
        let decrypted = crypto::decrypt_token(&raw_db_token, &master_key).expect("Decryption failed");
        assert_eq!(decrypted, raw_token, "Decrypted token must match original raw token");

        // 4. Test frontend masking
        let safe_created = created.with_masked_token();
        let json_val = serde_json::to_value(&safe_created).expect("Serialization failed");
        assert!(json_val.get("encrypted_token").is_none());
        assert!(json_val.get("masked_token").unwrap().as_str().unwrap().starts_with("vk_***"));
    }

    /// Task 5 Unit Test:
    /// Manually insert a post scheduled 5 minutes ago (300 seconds ago).
    /// Run one iteration of the worker and verify that post status transitions to 'published'.
    #[tokio::test]
    async fn test_scheduler_worker_publishes_due_post() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        let test_key = [88u8; 32];
        let plain_token = "vk1.a.secret_oauth_token_for_scheduled_post";
        let encrypted_token = crypto::encrypt_token(plain_token, &test_key).expect("Token encryption failed");

        // 1. Create account with encrypted token
        let acc_input = CreateAccountInput {
            id: None,
            platform: "vk".to_string(),
            name: "VK Scheduled Group".to_string(),
            encrypted_token,
            created_at: None,
        };
        let created_acc = db::create_account(&pool, acc_input).await.expect("Failed to create account");

        // 2. Insert post scheduled 5 minutes ago (now - 300 seconds)
        let five_minutes_ago = chrono::Utc::now().timestamp() - 300;
        let post_input = CreatePostInput {
            id: None,
            content: "Automated scheduled message from background worker".to_string(),
            media_urls: Some(vec!["https://example.com/banner.png".to_string()]),
            status: Some("scheduled".to_string()),
            scheduled_for: Some(five_minutes_ago),
            created_at: Some(five_minutes_ago - 120),
            format: None,
            destination_account_ids: Some(vec![created_acc.id.clone()]),
        };
        let created_post = db::create_post(&pool, post_input).await.expect("Failed to create post");
        assert_eq!(created_post.status, "scheduled");

        // 3. Execute one iteration of the worker
        let publisher = publisher::MockPublisher::with_delay(10);
        let count = scheduler::process_due_posts(None, &pool, &publisher, Some(test_key))
            .await
            .expect("Worker execution failed");

        assert_eq!(count, 1, "Should process exactly 1 due post");

        // 4. Verify post status in SQLite changed to 'published'
        let post_after = db::get_post_by_id(&pool, &created_post.id)
            .await
            .expect("Query failed")
            .expect("Post should exist");

        assert_eq!(
            post_after.status, "published",
            "Post status must be updated to 'published' by the background worker"
        );
    }

    #[tokio::test]
    async fn test_scheduler_worker_marks_failed_on_network_error() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        let test_key = [99u8; 32];
        let encrypted_token = crypto::encrypt_token("some_token", &test_key).unwrap();

        let acc = db::create_account(
            &pool,
            CreateAccountInput {
                id: None,
                platform: "tg".to_string(),
                name: "TG Channel".to_string(),
                encrypted_token,
                created_at: None,
            },
        )
        .await
        .unwrap();

        let five_minutes_ago = chrono::Utc::now().timestamp() - 300;
        let post = db::create_post(
            &pool,
            CreatePostInput {
                id: None,
                content: "Failing post".to_string(),
                media_urls: None,
                status: Some("scheduled".to_string()),
                scheduled_for: Some(five_minutes_ago),
                created_at: None,
                format: None,
                destination_account_ids: Some(vec![acc.id]),
            },
        )
        .await
        .unwrap();

        // Run with failing publisher
        let publisher = publisher::MockPublisher::failing();
        let _ = scheduler::process_due_posts(None, &pool, &publisher, Some(test_key)).await;

        let post_after = db::get_post_by_id(&pool, &post.id).await.unwrap().unwrap();
        assert_eq!(post_after.status, "failed", "Post must be marked 'failed' when network error occurs");
    }

    #[tokio::test]
    async fn test_partial_success_and_duplicate_protection() {
        use std::collections::HashMap;
        use std::sync::Mutex;

        struct TestPublisher {
            call_counts: Mutex<HashMap<String, usize>>,
        }

        impl publisher::PostPublisher for TestPublisher {
            async fn publish(
                &self,
                platform: &str,
                account_name: &str,
                token: &str,
                _content: &str,
                _media_urls: &[String],
                _format: &str,
                _target_id: Option<&str>,
            ) -> Result<String, String> {
                let mut counts = self.call_counts.lock().unwrap();
                *counts.entry(account_name.to_string()).or_insert(0) += 1;

                if account_name.contains("Failing") {
                    // Leak token and exceed 500 characters
                    let err = format!("API failed for token {}: {}", token, "E".repeat(700));
                    Err(err)
                } else {
                    Ok(format!("{}_ok_id", platform))
                }
            }
        }

        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        let test_key = [77u8; 32];
        let token_a = "token_account_a_clean";
        let token_b = "token_account_b_secret_leak";

        let enc_a = crypto::encrypt_token(token_a, &test_key).unwrap();
        let enc_b = crypto::encrypt_token(token_b, &test_key).unwrap();

        let acc_a = db::create_account(
            &pool,
            CreateAccountInput {
                id: None,
                platform: "vk".to_string(),
                name: "Success Channel A".to_string(),
                encrypted_token: enc_a,
                created_at: None,
            },
        )
        .await
        .unwrap();

        let acc_b = db::create_account(
            &pool,
            CreateAccountInput {
                id: None,
                platform: "tg".to_string(),
                name: "Failing Channel B".to_string(),
                encrypted_token: enc_b,
                created_at: None,
            },
        )
        .await
        .unwrap();

        let due_time = chrono::Utc::now().timestamp() - 100;
        let post = db::create_post(
            &pool,
            CreatePostInput {
                id: None,
                content: "Cross-platform post to A and B".to_string(),
                media_urls: None,
                status: Some("scheduled".to_string()),
                scheduled_for: Some(due_time),
                created_at: None,
                format: None,
                destination_account_ids: Some(vec![acc_a.id.clone(), acc_b.id.clone()]),
            },
        )
        .await
        .unwrap();

        let publisher = TestPublisher {
            call_counts: Mutex::new(HashMap::new()),
        };

        // 1. First iteration: Account A succeeds, Account B fails -> Post becomes partially_published
        let count = scheduler::process_due_posts(None, &pool, &publisher, Some(test_key))
            .await
            .expect("Worker iteration failed");
        assert_eq!(count, 1, "Should count partially published post as processed");

        let post_after = db::get_post_by_id(&pool, &post.id).await.unwrap().unwrap();
        assert_eq!(
            post_after.status, "partially_published",
            "Post must be marked 'partially_published'"
        );

        // Verify destinations
        let dests = db::get_post_destinations(&pool, &post.id).await.unwrap();
        let dest_a = dests.iter().find(|d| d.account_id == acc_a.id).unwrap();
        let dest_b = dests.iter().find(|d| d.account_id == acc_b.id).unwrap();

        assert_eq!(dest_a.status, "published");
        assert!(dest_a.error_log.is_none());

        assert_eq!(dest_b.status, "failed");
        let log_b = dest_b.error_log.as_ref().expect("error_log must be present");

        // Invariant: Secret Redaction 2.0 (token must not be present, [REDACTED] must be present)
        assert!(!log_b.contains(token_b), "Raw token must be redacted from error_log");
        assert!(log_b.contains("[REDACTED]"), "Redaction placeholder must be present");

        // Invariant: Log limit (max 500 characters)
        assert!(log_b.chars().count() <= 500, "error_log must be <= 500 characters");

        // 2. Second iteration: Duplicate protection test
        // Mark post back to scheduled to simulate manual retry or rerun
        db::update_post_status(&pool, &post.id, "scheduled").await.unwrap();

        let _ = scheduler::process_due_posts(None, &pool, &publisher, Some(test_key)).await;

        let counts = publisher.call_counts.lock().unwrap();
        // Invariant: Account A must NOT be re-sent because its destination status was 'published'
        assert_eq!(
            *counts.get("Success Channel A").unwrap_or(&0),
            1,
            "Account A must NOT be published to again (Duplicate Protection)"
        );
        // Account B was failed so it was retried
        assert_eq!(
            *counts.get("Failing Channel B").unwrap_or(&0),
            2,
            "Account B was retried"
        );
    }

    #[tokio::test]
    async fn test_draft_and_scheduled_post_validation() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        // 1. Draft post without destination accounts and empty content should succeed
        let draft_input = CreatePostInput {
            id: None,
            content: "".to_string(),
            media_urls: None,
            status: Some("draft".to_string()),
            scheduled_for: None,
            created_at: None,
            format: None,
            destination_account_ids: None,
        };
        let created_draft = db::create_post(&pool, draft_input).await.expect("Draft creation should succeed");
        assert_eq!(created_draft.status, "draft");
        assert_eq!(created_draft.content, "");
        assert_eq!(created_draft.destination_account_ids.len(), 0);

        // 2. Scheduled post with empty content must be rejected
        let invalid_scheduled = CreatePostInput {
            id: None,
            content: "   ".to_string(),
            media_urls: None,
            status: Some("scheduled".to_string()),
            scheduled_for: Some(chrono::Utc::now().timestamp() + 3600),
            created_at: None,
            format: None,
            destination_account_ids: None,
        };
        let res = db::create_post(&pool, invalid_scheduled).await;
        assert!(res.is_err(), "Scheduled post with whitespace content must be rejected");
    }

    #[tokio::test]
    async fn test_api_credentials_crud_and_encryption() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        let test_master_key = [42u8; 32];
        let raw_api_key = "sk-proj-1234567890abcdef12345678";
        let encrypted_key = crypto::encrypt_token(raw_api_key, &test_master_key).unwrap();

        // 1. Create API credential
        let cred = db::create_api_credential(
            &pool,
            None,
            "openai_compat",
            "OpenAI Main",
            "https://api.openai.com/v1",
            &encrypted_key,
            None,
        )
        .await
        .expect("Creation must succeed");

        assert_eq!(cred.name, "OpenAI Main");
        assert_eq!(cred.provider, "openai_compat");
        assert_eq!(cred.base_url, "https://api.openai.com/v1");

        // 2. Query all credentials
        let list = db::get_api_credentials(&pool).await.expect("Query must succeed");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, cred.id);

        // 3. Verify raw key in SQLite is encrypted and never plain
        let db_encrypted: String = sqlx::query_scalar("SELECT encrypted_key FROM api_credentials WHERE id = ?")
            .bind(&cred.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(db_encrypted, encrypted_key);
        assert_ne!(db_encrypted, raw_api_key);

        // 4. Decrypt back
        let decrypted = crypto::decrypt_token(&db_encrypted, &test_master_key).unwrap();
        assert_eq!(decrypted, raw_api_key);

        // 5. Invariant: Frontend isolation: real and encrypted key omitted from JSON serialization
        let masked = models::mask_api_key(&decrypted);
        assert_eq!(masked, "sk-...5678");

        let safe_cred = cred.with_masked_key(masked);
        let val = serde_json::to_value(&safe_cred).unwrap();
        let obj = val.as_object().unwrap();

        assert!(!obj.contains_key("encrypted_key"), "encrypted_key must be skipped in JSON serialization");
        assert_eq!(obj.get("masked_key").and_then(|v| v.as_str()), Some("sk-...5678"));

        // 6. Delete credential
        let deleted = db::delete_api_credential(&pool, &safe_cred.id).await.unwrap();
        assert!(deleted);

        let list_after = db::get_api_credentials(&pool).await.unwrap();
        assert_eq!(list_after.len(), 0);
    }

    #[test]
    fn test_mask_api_key_varieties() {
        assert_eq!(models::mask_api_key("sk-1234567890abcdef"), "sk-...cdef");
        assert_eq!(models::mask_api_key("sk-ant-api03-1234"), "sk-...1234");
        assert_eq!(models::mask_api_key("short"), "***");
        assert_eq!(models::mask_api_key("1234567"), "***");
        assert_eq!(models::mask_api_key("12345678"), "123...5678");
    }

    #[test]
    fn test_humanizer_prompt_assembly() {
        // 1. Without humanizer
        let prompt_plain = commands::build_rewrite_system_prompt("Сделай короче", false);
        assert!(prompt_plain.contains("Ты профессиональный SMM-копирайтер"));
        assert!(prompt_plain.contains("ЗАДАЧА ПОЛЬЗОВАТЕЛЯ: Сделай короче"));
        assert!(!prompt_plain.contains("HUMANIZATION RULES"));

        // 2. With humanizer: invariant order [СИСТЕМНАЯ РОЛЬ] -> [HUMANIZATION RULES] -> [ЗАДАЧА ПОЛЬЗОВАТЕЛЯ]
        let prompt_humanized = commands::build_rewrite_system_prompt("Сделай короче", true);
        assert!(prompt_humanized.contains("HUMANIZATION RULES"));
        assert!(prompt_humanized.contains("High Burstiness"));
        assert!(prompt_humanized.contains("High Perplexity"));
        assert!(prompt_humanized.contains("Banned Words"));

        let role_pos = prompt_humanized.find("Ты профессиональный SMM-копирайтер").unwrap();
        let humanizer_pos = prompt_humanized.find("HUMANIZATION RULES").unwrap();
        let task_pos = prompt_humanized.find("ЗАДАЧА ПОЛЬЗОВАТЕЛЯ").unwrap();

        assert!(role_pos < humanizer_pos, "Role must come before Humanizer rules");
        assert!(humanizer_pos < task_pos, "Humanizer rules must come before user task");
    }

    #[tokio::test]
    async fn test_crm_leads_crud_and_upsert() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        // 1. Add lead
        let input = models::CreateLeadInput {
            id: None,
            platform: "vk".to_string(),
            external_id: "id123456".to_string(),
            name: "Иван Иванов".to_string(),
            funnel_stage: Some("new".to_string()),
            last_interaction_at: None,
            created_at: None,
        };
        let created = db::add_lead(&pool, input).await.expect("Add lead failed");
        assert_eq!(created.name, "Иван Иванов");
        assert_eq!(created.funnel_stage, "new");

        // 2. Fetch leads
        let leads = db::get_leads(&pool).await.expect("Get leads failed");
        assert_eq!(leads.len(), 1);
        assert_eq!(leads[0].id, created.id);

        // 3. Upsert: same platform and external_id with updated name and stage
        let upsert_input = models::CreateLeadInput {
            id: None,
            platform: "vk".to_string(),
            external_id: "id123456".to_string(),
            name: "Иван Иванов (VIP)".to_string(),
            funnel_stage: Some("aida_attention".to_string()),
            last_interaction_at: None,
            created_at: None,
        };
        let upserted = db::add_lead(&pool, upsert_input).await.expect("Upsert failed");
        assert_eq!(upserted.id, created.id);
        assert_eq!(upserted.name, "Иван Иванов (VIP)");
        assert_eq!(upserted.funnel_stage, "aida_attention");

        // 4. Update stage directly
        let updated = db::update_lead_stage(&pool, &created.id, "closed").await.unwrap();
        assert!(updated);
        let lead_after = db::get_lead_by_id(&pool, &created.id).await.unwrap().unwrap();
        assert_eq!(lead_after.funnel_stage, "closed");

        // 5. Test dead leads cold marking
        // Create an inactive lead with last_interaction 4 days ago
        let four_days_ago = chrono::Utc::now().timestamp() - (4 * 86400);
        let dead_lead_input = models::CreateLeadInput {
            id: None,
            platform: "tg".to_string(),
            external_id: "@ghost_user".to_string(),
            name: "Молчун".to_string(),
            funnel_stage: Some("request_sent".to_string()),
            last_interaction_at: Some(four_days_ago),
            created_at: Some(four_days_ago),
        };
        let dead_lead = db::add_lead(&pool, dead_lead_input).await.unwrap();
        assert_eq!(dead_lead.funnel_stage, "request_sent");

        // Mark leads dead (> 3 days)
        let marked = db::mark_dead_leads_as_cold(&pool, 3).await.unwrap();
        assert!(marked >= 1);

        let dead_after = db::get_lead_by_id(&pool, &dead_lead.id).await.unwrap().unwrap();
        assert_eq!(dead_after.funnel_stage, "cold");

        // 6. Delete lead
        let deleted = db::delete_lead(&pool, &created.id).await.unwrap();
        assert!(deleted);
    }

    #[tokio::test]
    async fn test_automation_queue_scheduling_and_rate_limiting() {
        let temp_dir = tempdir().expect("Failed to create temp dir");
        let pool = db::init_db(temp_dir.path()).await.expect("Failed to init db");

        let test_master_key = [33u8; 32];
        let enc_token = crypto::encrypt_token("vk_token_123", &test_master_key).unwrap();

        // 1. Create account
        let acc = db::create_account(
            &pool,
            models::CreateAccountInput {
                id: None,
                platform: "vk".to_string(),
                name: "VK Seller".to_string(),
                encrypted_token: enc_token,
                created_at: None,
            },
        )
        .await
        .unwrap();

        // 2. Create lead
        let lead = db::add_lead(
            &pool,
            models::CreateLeadInput {
                id: None,
                platform: "vk".to_string(),
                external_id: "vk_client_1".to_string(),
                name: "Клиент 1".to_string(),
                funnel_stage: Some("new".to_string()),
                last_interaction_at: None,
                created_at: None,
            },
        )
        .await
        .unwrap();

        // 3. Schedule task with execute_after in the past
        let past = chrono::Utc::now().timestamp() - 10;
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

        assert_eq!(task.status, "pending");

        // Also schedule a second task for the same account
        let _task2 = db::add_queue_item(
            &pool,
            None,
            &lead.id,
            &acc.id,
            "send_message",
            r#"{"text":"Привет"}"#,
            past,
        )
        .await
        .unwrap();

        // 4. Run automation worker iteration with mock connector
        struct MockCrmConnector;
        impl crm_connectors::CrmConnector for MockCrmConnector {
            async fn execute_action(
                &self,
                platform: &str,
                _token: &str,
                _external_id: &str,
                _action_type: &str,
                _payload: &str,
            ) -> Result<String, String> {
                Ok(format!("{}_ok", platform))
            }
        }

        let limiter = automation_worker::AutomationRateLimiter::new();
        let connector = MockCrmConnector;
        let executed = automation_worker::process_due_automation_tasks_with_connector(
            None,
            &pool,
            &limiter,
            &connector,
            Some(test_master_key),
        )
        .await
        .expect("Execution failed");

        // Invariant: Rate Limiter permits exactly 1 action per minute per account!
        assert_eq!(executed, 1, "Global Rate Limiter must allow only 1 action per minute for account");

        // Verify task 1 is completed
        let tasks = db::get_automation_queue(&pool).await.unwrap();
        let completed_task = tasks.iter().find(|t| t.id == task.id).unwrap();
        assert_eq!(completed_task.status, "completed");

        // Verify lead moved to request_sent
        let lead_after = db::get_lead_by_id(&pool, &lead.id).await.unwrap().unwrap();
        assert_eq!(lead_after.funnel_stage, "request_sent");

        // 5. Test Cascade Delete: deleting lead removes its tasks
        db::delete_lead(&pool, &lead.id).await.unwrap();
        let remaining_tasks = db::get_automation_queue(&pool).await.unwrap();
        assert_eq!(remaining_tasks.len(), 0, "Queue tasks must be cascaded on lead deletion");
    }
}
