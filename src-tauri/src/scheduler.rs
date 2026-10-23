use std::time::Duration;
use sqlx::SqlitePool;
use zeroize::Zeroize;
use crate::crypto;
use crate::db;
use crate::logger;
use crate::publisher::{PostPublisher, RealPublisher};
use crate::worker_status;

pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Run one iteration of processing all due scheduled posts.
/// Returns the number of successfully published posts.
/// Accepts optional AppHandle to emit live system events to the frontend.
pub async fn process_due_posts<P: PostPublisher>(
    app: Option<&tauri::AppHandle>,
    pool: &SqlitePool,
    publisher: &P,
    key_override: Option<[u8; 32]>,
) -> Result<usize, String> {
    let now = chrono::Utc::now().timestamp();
    let due_posts = db::get_due_posts(pool, now).await?;

    if due_posts.is_empty() {
        return Ok(0);
    }

    logger::emit_log_opt(
        app,
        "info",
        &format!("Найдено {} пост(ов), готовых к публикации", due_posts.len()),
    );
    let mut published_count = 0;

    for post in due_posts {
        // Invariant: Atomic lock on post.
        // If 0 rows affected, another process or thread already locked it -> skip.
        let locked = db::try_lock_post_for_publishing(pool, &post.id).await?;
        if !locked {
            logger::emit_log_opt(
                app,
                "info",
                &format!("Пост '{}' уже заблокирован другим процессом, пропуск", post.id),
            );
            continue;
        }

        logger::emit_log_opt(
            app,
            "info",
            &format!("Пост '{}' заблокирован для публикации (статус 'publishing')", post.id),
        );

        // Edge case: Post must have destination accounts
        if post.destination_account_ids.is_empty() {
            logger::emit_log_opt(
                app,
                "warn",
                &format!("Пост '{}' не имеет целевых аккаунтов, перевод в статус 'failed'", post.id),
            );
            db::update_post_status(pool, &post.id, "failed").await?;
            continue;
        }

        // Edge case: Access to OS Keyring
        let master_key = match key_override {
            Some(key) => Ok(key),
            None => crypto::get_or_generate_key().map_err(|e| {
                format!("Нет доступа к ключам ОС: {}", e)
            }),
        };

        let master_key = match master_key {
            Ok(k) => k,
            Err(err_msg) => {
                logger::emit_log_opt(
                    app,
                    "error",
                    &format!("Пост '{}': ошибка получения мастер-ключа: {}, перевод в 'failed'", post.id, err_msg),
                );
                db::update_post_status(pool, &post.id, "failed").await?;
                continue;
            }
        };

        // Iterate over destinations: Only process pending or failed destinations.
        // Invariant: Duplicate protection: Re-sending to an already 'published' destination is FORBIDDEN.
        let destinations = db::get_post_destinations(pool, &post.id).await?;

        for dest in destinations {
            if dest.status == "published" {
                logger::emit_log_opt(
                    app,
                    "info",
                    &format!("Аккаунт destination '{}' для поста '{}' уже опубликован, пропуск", dest.account_id, post.id),
                );
                continue;
            }

            let account = match db::get_account_by_id(pool, &dest.account_id).await? {
                Some(acc) => acc,
                None => {
                    logger::emit_log_opt(
                        app,
                        "error",
                        &format!("Целевой аккаунт '{}' для поста '{}' не найден в базе данных", dest.account_id, post.id),
                    );
                    db::update_destination_status(
                        pool,
                        &post.id,
                        &dest.account_id,
                        "failed",
                        Some("Account not found in database"),
                    )
                    .await?;
                    continue;
                }
            };

            // Decrypt token
            let mut plain_token = match crypto::decrypt_token(&account.encrypted_token, &master_key) {
                Ok(token) => token,
                Err(e) => {
                    logger::emit_log_opt(
                        app,
                        "error",
                        &format!("Ошибка расшифровки токена для аккаунта '{}' (пост '{}'): {}", account.name, post.id, e),
                    );
                    db::update_destination_status(
                        pool,
                        &post.id,
                        &dest.account_id,
                        "failed",
                        Some("Failed to decrypt access token"),
                    )
                    .await?;
                    continue;
                }
            };

            logger::emit_log_opt(
                app,
                "info",
                &format!("Отправка поста '{}' в {} ('{}')...", post.id, account.platform.to_uppercase(), account.name),
            );

            // Publish via connector
            let publish_result = publisher
                .publish(
                    &account.platform,
                    &account.name,
                    &plain_token,
                    &post.content,
                    &post.media_urls,
                    &post.format,
                    account.target_id.as_deref(),
                )
                .await;

            // Invariant: Secret Redaction 2.0 & Log limit (max 500 characters)
            match publish_result {
                Ok(external_id) => {
                    logger::emit_log_opt(
                        app,
                        "success",
                        &format!("Успешно опубликован пост '{}' в {} ('{}') (ID: {})", post.id, account.platform.to_uppercase(), account.name, external_id),
                    );
                    db::update_destination_status(
                        pool,
                        &post.id,
                        &dest.account_id,
                        "published",
                        None,
                    )
                    .await?;
                }
                Err(raw_error) => {
                    // Replace plain token if accidentally present
                    let sanitized = raw_error.replace(&plain_token, "[REDACTED]");
                    // Truncate to at most 500 characters safely
                    let final_log: String = sanitized.chars().take(500).collect();
                    logger::emit_log_opt(
                        app,
                        "error",
                        &format!("Ошибка публикации в {} ('{}'): {}", account.platform.to_uppercase(), account.name, final_log),
                    );
                    db::update_destination_status(
                        pool,
                        &post.id,
                        &dest.account_id,
                        "failed",
                        Some(&final_log),
                    )
                    .await?;
                }
            }

            // Invariant: Immediately zeroize plain-text token from memory
            plain_token.zeroize();
        }

        // Edge case: Post status aggregation
        // All published -> published; both published and failed -> partially_published; all failed -> failed.
        let all_dests = db::get_post_destinations(pool, &post.id).await?;
        let total = all_dests.len();
        let published_dests = all_dests.iter().filter(|d| d.status == "published").count();
        let failed_dests = all_dests.iter().filter(|d| d.status == "failed").count();

        let final_status = if total == 0 {
            "failed"
        } else if published_dests == total {
            "published"
        } else if failed_dests == total {
            "failed"
        } else if published_dests > 0 {
            "partially_published"
        } else {
            "failed"
        };

        db::update_post_status(pool, &post.id, final_status).await?;
        let level = match final_status {
            "published" => "success",
            "partially_published" => "warn",
            _ => "error",
        };
        logger::emit_log_opt(
            app,
            level,
            &format!(
                "Пост '{}' переведен в статус '{}' (успешно: {}/{}, ошибок: {})",
                post.id, final_status, published_dests, total, failed_dests
            ),
        );

        if final_status == "published" || final_status == "partially_published" {
            published_count += 1;
        }
    }

    Ok(published_count)
}

/// Start the background worker inside Tokio runtime.
/// Invariant: Non-blocking via `tauri::async_runtime::spawn`.
/// Accepts AppHandle to emit live system logs to the React UI.
pub fn start_worker(app: tauri::AppHandle, pool: SqlitePool) {
    tauri::async_runtime::spawn(async move {
        let publisher = RealPublisher::new();
        worker_status::scheduler_set_running();
        logger::emit_log(
            &app,
            "info",
            &format!(
                "Фоновый воркер планировщика запущен (интервал: {:?})",
                DEFAULT_POLL_INTERVAL
            ),
        );

        loop {
            match process_due_posts(Some(&app), &pool, &publisher, None).await {
                Ok(count) => worker_status::scheduler_record_iteration(count),
                Err(e) => {
                    logger::emit_log(
                        &app,
                        "error",
                        &format!("Ошибка цикла планировщика: {}", e),
                    );
                }
            }
            tokio::time::sleep(DEFAULT_POLL_INTERVAL).await;
        }
    });
}
