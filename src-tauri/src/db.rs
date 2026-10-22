use std::path::Path;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};
use uuid::Uuid;
use crate::models::{
    Account, ApiCredential, AutomationQueueItem, CreateAccountInput, CreateLeadInput,
    CreatePostInput, DestinationInfo, EnrichedAutomationQueueItem, Lead, Post, PostRow,
    PostStatus,
};

pub const DB_FILE_NAME: &str = "smm_local.db";
pub const MIGRATION_01_SQL: &str = include_str!("../migrations/01_initial.sql");
pub const MIGRATION_02_SQL: &str = include_str!("../migrations/02_add_destinations_status.sql");
pub const MIGRATION_03_SQL: &str = include_str!("../migrations/03_api_credentials.sql");
pub const MIGRATION_04_SQL: &str = include_str!("../migrations/04_crm_and_funnels.sql");
pub const MIGRATION_05_SQL: &str = include_str!("../migrations/05_post_format.sql");
pub const INITIAL_MIGRATION_SQL: &str = MIGRATION_01_SQL;

/// Holds the SQLite connection pool as Tauri managed state
pub struct DbState {
    pub pool: SqlitePool,
}

/// Initialize SQLite database in the given directory with foreign_keys and WAL mode enabled.
pub async fn init_db(app_data_dir: &Path) -> Result<SqlitePool, String> {
    // Edge case: Ensure app_data_dir exists
    if !app_data_dir.exists() {
        std::fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("Failed to create App Data directory at {:?}: {}", app_data_dir, e))?;
    }

    let db_path = app_data_dir.join(DB_FILE_NAME);

    // Invariant: PRAGMA foreign_keys = ON; WAL journal mode; create if missing
    let connect_options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(connect_options)
        .await
        .map_err(|e| format!("Failed to open database at {:?}: {}", db_path, e))?;

    // Apply migrations
    apply_migrations(&pool).await?;

    Ok(pool)
}

/// Execute migration statements tracked by `_schema_migrations`
pub async fn apply_migrations(pool: &SqlitePool) -> Result<(), String> {
    // Ensure migrations tracking table exists
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS _schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create _schema_migrations table: {}", e))?;

    let applied_versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM _schema_migrations")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to query applied migrations: {}", e))?;

    // Migration 01
    if !applied_versions.contains(&1) {
        for statement in MIGRATION_01_SQL.split(';') {
            let trimmed = statement.trim();
            if !trimmed.is_empty() {
                sqlx::query(trimmed)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("Migration 01 statement failed ({}): {}", trimmed, e))?;
            }
        }
        sqlx::query("INSERT INTO _schema_migrations (version, applied_at) VALUES (1, ?)")
            .bind(chrono::Utc::now().timestamp())
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to record migration 01: {}", e))?;
    }

    // Migration 02
    if !applied_versions.contains(&2) {
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('post_destinations')")
            .fetch_all(pool)
            .await
            .unwrap_or_default();

        if !columns.contains(&"status".to_string()) {
            sqlx::query("ALTER TABLE post_destinations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'published', 'failed'))")
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to add status to post_destinations: {}", e))?;
        }

        if !columns.contains(&"error_log".to_string()) {
            sqlx::query("ALTER TABLE post_destinations ADD COLUMN error_log TEXT")
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to add error_log to post_destinations: {}", e))?;
        }

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_post_destinations_status ON post_destinations(status)")
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to create idx_post_destinations_status: {}", e))?;

        sqlx::query("INSERT INTO _schema_migrations (version, applied_at) VALUES (2, ?)")
            .bind(chrono::Utc::now().timestamp())
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to record migration 02: {}", e))?;
    }

    // Migration 03
    if !applied_versions.contains(&3) {
        for statement in MIGRATION_03_SQL.split(';') {
            let trimmed = statement.trim();
            if !trimmed.is_empty() {
                sqlx::query(trimmed)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("Migration 03 statement failed ({}): {}", trimmed, e))?;
            }
        }
        sqlx::query("INSERT INTO _schema_migrations (version, applied_at) VALUES (3, ?)")
            .bind(chrono::Utc::now().timestamp())
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to record migration 03: {}", e))?;
    }

    // Migration 04 (Local CRM & Funnels Automation Queue)
    if !applied_versions.contains(&4) {
        for statement in MIGRATION_04_SQL.split(';') {
            let trimmed = statement.trim();
            if !trimmed.is_empty() {
                sqlx::query(trimmed)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("Migration 04 statement failed ({}): {}", trimmed, e))?;
            }
        }
        sqlx::query("INSERT INTO _schema_migrations (version, applied_at) VALUES (4, ?)")
            .bind(chrono::Utc::now().timestamp())
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to record migration 04: {}", e))?;
    }

    // Migration 05 (Post format: post | article)
    if !applied_versions.contains(&5) {
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('posts')")
            .fetch_all(pool)
            .await
            .unwrap_or_default();

        if !columns.contains(&"format".to_string()) {
            sqlx::query("ALTER TABLE posts ADD COLUMN format TEXT NOT NULL DEFAULT 'post'")
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to add format to posts: {}", e))?;
        }

        sqlx::query("INSERT INTO _schema_migrations (version, applied_at) VALUES (5, ?)")
            .bind(chrono::Utc::now().timestamp())
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to record migration 05: {}", e))?;
    }

    Ok(())
}

// ==========================================
// Accounts Operations
// ==========================================

pub async fn create_account(pool: &SqlitePool, input: CreateAccountInput) -> Result<Account, String> {
    let platform = input.platform.trim();
    if platform.is_empty() {
        return Err("Account 'platform' cannot be empty".to_string());
    }

    let name = input.name.trim();
    if name.is_empty() {
        return Err("Account 'name' cannot be empty".to_string());
    }

    // Validate or generate UUID
    let id = match input.id {
        Some(ref id_str) => {
            Uuid::parse_str(id_str)
                .map_err(|e| format!("Invalid UUID for account id '{}': {}", id_str, e))?
                .to_string()
        }
        None => Uuid::new_v4().to_string(),
    };

    let created_at = input.created_at.unwrap_or_else(|| chrono::Utc::now().timestamp());

    sqlx::query(
        r#"
        INSERT INTO accounts (id, platform, name, encrypted_token, created_at)
        VALUES (?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(platform)
    .bind(name)
    .bind(&input.encrypted_token)
    .bind(created_at)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to insert account: {}", e))?;

    Ok(Account {
        id,
        platform: platform.to_string(),
        name: name.to_string(),
        encrypted_token: input.encrypted_token,
        created_at,
        masked_token: None,
    })
}

pub async fn get_accounts(pool: &SqlitePool) -> Result<Vec<Account>, String> {
    let accounts = sqlx::query_as::<_, Account>(
        r#"
        SELECT id, platform, name, encrypted_token, created_at
        FROM accounts
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch accounts: {}", e))?;

    Ok(accounts)
}

pub async fn get_account_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Account>, String> {
    let account = sqlx::query_as::<_, Account>(
        r#"
        SELECT id, platform, name, encrypted_token, created_at
        FROM accounts
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch account by id '{}': {}", id, e))?;

    Ok(account)
}

pub async fn delete_account(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let result = sqlx::query("DELETE FROM accounts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete account '{}': {}", id, e))?;

    Ok(result.rows_affected() > 0)
}

// ==========================================
// Posts & Destinations Operations
// ==========================================

pub async fn create_post(pool: &SqlitePool, input: CreatePostInput) -> Result<Post, String> {
    let status_str = input.status.unwrap_or_else(|| "draft".to_string());
    let status: PostStatus = status_str
        .parse()
        .map_err(|e: String| format!("Invalid post status: {}", e))?;

    let content = input.content.trim();
    // Rule: drafts may have empty or partial content; scheduled/published must have non-empty content
    if status != PostStatus::Draft && content.is_empty() {
        return Err("Post 'content' cannot be empty for scheduled post".to_string());
    }

    let id = match input.id {
        Some(ref id_str) => {
            Uuid::parse_str(id_str)
                .map_err(|e| format!("Invalid UUID for post id '{}': {}", id_str, e))?
                .to_string()
        }
        None => Uuid::new_v4().to_string(),
    };

    let media_urls_vec = input.media_urls.unwrap_or_default();
    let media_urls_json = serde_json::to_string(&media_urls_vec)
        .map_err(|e| format!("Failed to serialize media_urls: {}", e))?;

    let created_at = input.created_at.unwrap_or_else(|| chrono::Utc::now().timestamp());
    let scheduled_for = input.scheduled_for;
    let destination_ids = input.destination_account_ids.unwrap_or_default();
    let format = match input.format.as_deref() {
        Some("article") => "article".to_string(),
        _ => "post".to_string(),
    };

    // Use a transaction to ensure post and destinations are saved together
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    sqlx::query(
        r#"
        INSERT INTO posts (id, content, media_urls, status, scheduled_for, created_at, format)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(content)
    .bind(&media_urls_json)
    .bind(&status_str)
    .bind(scheduled_for)
    .bind(created_at)
    .bind(&format)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("Failed to insert post: {}", e))?;

    // Insert destination accounts if provided
    for account_id in &destination_ids {
        // Invariant: Foreign keys enforced. If account_id doesn't exist, this fails!
        sqlx::query(
            r#"
            INSERT INTO post_destinations (post_id, account_id, status, error_log)
            VALUES (?, ?, 'pending', NULL)
            "#,
        )
        .bind(&id)
        .bind(account_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Failed to link destination account '{}' to post: {}", account_id, e))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    let destinations: Vec<DestinationInfo> = destination_ids
        .iter()
        .map(|acc_id| DestinationInfo {
            account_id: acc_id.clone(),
            status: "pending".to_string(),
            error_log: None,
        })
        .collect();

    Ok(Post {
        id,
        content: content.to_string(),
        media_urls: media_urls_vec,
        status: status_str,
        scheduled_for,
        created_at,
        format,
        destination_account_ids: destination_ids,
        destinations,
    })
}

pub async fn get_posts(pool: &SqlitePool) -> Result<Vec<Post>, String> {
    let rows = sqlx::query_as::<_, PostRow>(
        r#"
        SELECT id, content, media_urls, status, scheduled_for, created_at, format
        FROM posts
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch posts: {}", e))?;

    let mut posts = Vec::with_capacity(rows.len());

    for row in rows {
        let media_urls: Vec<String> = serde_json::from_str(&row.media_urls).unwrap_or_default();

        let dest_rows = sqlx::query_as::<_, (String, String, Option<String>)>(
            r#"
            SELECT account_id, status, error_log
            FROM post_destinations
            WHERE post_id = ?
            "#,
        )
        .bind(&row.id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch destinations for post '{}': {}", row.id, e))?;

        let destinations: Vec<DestinationInfo> = dest_rows
            .into_iter()
            .map(|(account_id, status, error_log)| DestinationInfo {
                account_id,
                status,
                error_log,
            })
            .collect();

        let destination_account_ids = destinations
            .iter()
            .map(|d| d.account_id.clone())
            .collect();

        posts.push(Post {
            id: row.id,
            content: row.content,
            media_urls,
            status: row.status,
            scheduled_for: row.scheduled_for,
            created_at: row.created_at,
            format: row.format,
            destination_account_ids,
            destinations,
        });
    }

    Ok(posts)
}

pub async fn delete_post(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let result = sqlx::query("DELETE FROM posts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete post '{}': {}", id, e))?;

    Ok(result.rows_affected() > 0)
}

/// Retrieve posts ready for publication: status is 'scheduled' and scheduled_for <= current_timestamp
pub async fn get_due_posts(pool: &SqlitePool, current_timestamp: i64) -> Result<Vec<Post>, String> {
    let rows = sqlx::query_as::<_, PostRow>(
        r#"
        SELECT id, content, media_urls, status, scheduled_for, created_at, format
        FROM posts
        WHERE status = 'scheduled' AND scheduled_for <= ?
        ORDER BY scheduled_for ASC
        "#,
    )
    .bind(current_timestamp)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch due posts: {}", e))?;

    let mut posts = Vec::with_capacity(rows.len());

    for row in rows {
        let media_urls: Vec<String> = serde_json::from_str(&row.media_urls).unwrap_or_default();

        let dest_rows = sqlx::query_as::<_, (String, String, Option<String>)>(
            r#"
            SELECT account_id, status, error_log
            FROM post_destinations
            WHERE post_id = ?
            "#,
        )
        .bind(&row.id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch destinations for due post '{}': {}", row.id, e))?;

        let destinations: Vec<DestinationInfo> = dest_rows
            .into_iter()
            .map(|(account_id, status, error_log)| DestinationInfo {
                account_id,
                status,
                error_log,
            })
            .collect();

        let destination_account_ids = destinations
            .iter()
            .map(|d| d.account_id.clone())
            .collect();

        posts.push(Post {
            id: row.id,
            content: row.content,
            media_urls,
            status: row.status,
            scheduled_for: row.scheduled_for,
            created_at: row.created_at,
            format: row.format,
            destination_account_ids,
            destinations,
        });
    }

    Ok(posts)
}

/// Invariant: Atomic lock. Changes status from 'scheduled' to 'publishing'.
/// Returns true if locked successfully, false if already taken or not in 'scheduled' state.
pub async fn try_lock_post_for_publishing(pool: &SqlitePool, post_id: &str) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE posts
        SET status = 'publishing'
        WHERE id = ? AND status = 'scheduled'
        "#,
    )
    .bind(post_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to atomically lock post '{}': {}", post_id, e))?;

    Ok(result.rows_affected() > 0)
}

/// Update post status (e.g. to 'published', 'failed', 'publishing', 'partially_published')
pub async fn update_post_status(pool: &SqlitePool, post_id: &str, status: &str) -> Result<bool, String> {
    // Validate status string against PostStatus
    let _valid_status: PostStatus = status
        .parse()
        .map_err(|e: String| format!("Invalid post status '{}': {}", status, e))?;

    let result = sqlx::query(
        r#"
        UPDATE posts
        SET status = ?
        WHERE id = ?
        "#,
    )
    .bind(status)
    .bind(post_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update status for post '{}': {}", post_id, e))?;

    Ok(result.rows_affected() > 0)
}

/// Update destination status and error_log for a specific account on a post
pub async fn update_destination_status(
    pool: &SqlitePool,
    post_id: &str,
    account_id: &str,
    status: &str,
    error_log: Option<&str>,
) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE post_destinations
        SET status = ?, error_log = ?
        WHERE post_id = ? AND account_id = ?
        "#,
    )
    .bind(status)
    .bind(error_log)
    .bind(post_id)
    .bind(account_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update destination status: {}", e))?;

    Ok(result.rows_affected() > 0)
}

/// Fetch destinations for a specific post
pub async fn get_post_destinations(
    pool: &SqlitePool,
    post_id: &str,
) -> Result<Vec<DestinationInfo>, String> {
    let dest_rows = sqlx::query_as::<_, (String, String, Option<String>)>(
        r#"
        SELECT account_id, status, error_log
        FROM post_destinations
        WHERE post_id = ?
        "#,
    )
    .bind(post_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch destinations for post '{}': {}", post_id, e))?;

    Ok(dest_rows
        .into_iter()
        .map(|(account_id, status, error_log)| DestinationInfo {
            account_id,
            status,
            error_log,
        })
        .collect())
}

/// Fetch a post by ID including its destination account IDs and destination details
pub async fn get_post_by_id(pool: &SqlitePool, post_id: &str) -> Result<Option<Post>, String> {
    let maybe_row = sqlx::query_as::<_, PostRow>(
        r#"
        SELECT id, content, media_urls, status, scheduled_for, created_at, format
        FROM posts
        WHERE id = ?
        "#,
    )
    .bind(post_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch post by id '{}': {}", post_id, e))?;

    match maybe_row {
        Some(row) => {
            let media_urls: Vec<String> = serde_json::from_str(&row.media_urls).unwrap_or_default();
            let destinations = get_post_destinations(pool, &row.id).await?;
            let destination_account_ids = destinations
                .iter()
                .map(|d| d.account_id.clone())
                .collect();

            Ok(Some(Post {
                id: row.id,
                content: row.content,
                media_urls,
                status: row.status,
                scheduled_for: row.scheduled_for,
                created_at: row.created_at,
                format: row.format,
                destination_account_ids,
                destinations,
            }))
        }
        None => Ok(None),
    }
}

/// Reset a failed or partially_published post for re-execution by scheduler.
/// Sets post status to 'scheduled' with current timestamp, and resets failed destinations to 'pending'.
pub async fn retry_post(pool: &SqlitePool, post_id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();

    // 1. Reset post status to scheduled for immediate processing
    sqlx::query("UPDATE posts SET status = 'scheduled', scheduled_for = ? WHERE id = ?")
        .bind(now)
        .bind(post_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to reset post status for retry: {}", e))?;

    // 2. Reset failed destinations to pending and clear error_log
    sqlx::query("UPDATE post_destinations SET status = 'pending', error_log = NULL WHERE post_id = ? AND status = 'failed'")
        .bind(post_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to reset destination status for retry: {}", e))?;

    Ok(())
}

// ==========================================
// API Credentials Operations (LLM Gateway)
// ==========================================

pub async fn create_api_credential(
    pool: &SqlitePool,
    id: Option<String>,
    provider: &str,
    name: &str,
    base_url: &str,
    encrypted_key: &str,
    created_at: Option<i64>,
) -> Result<ApiCredential, String> {
    let provider = provider.trim();
    if provider != "openai_compat" && provider != "anthropic" {
        return Err(format!(
            "Invalid provider '{}'. Supported providers are 'openai_compat' or 'anthropic'",
            provider
        ));
    }

    let name = name.trim();
    if name.is_empty() {
        return Err("Credential 'name' cannot be empty".to_string());
    }

    let base_url = base_url.trim();
    if base_url.is_empty() {
        return Err("Credential 'base_url' cannot be empty".to_string());
    }

    let encrypted_key = encrypted_key.trim();
    if encrypted_key.is_empty() {
        return Err("Credential key cannot be empty".to_string());
    }

    let id = match id {
        Some(ref id_str) => {
            Uuid::parse_str(id_str)
                .map_err(|e| format!("Invalid UUID for credential id '{}': {}", id_str, e))?
                .to_string()
        }
        None => Uuid::new_v4().to_string(),
    };

    let created_at = created_at.unwrap_or_else(|| chrono::Utc::now().timestamp());

    sqlx::query(
        r#"
        INSERT INTO api_credentials (id, provider, name, base_url, encrypted_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(provider)
    .bind(name)
    .bind(base_url)
    .bind(encrypted_key)
    .bind(created_at)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to insert api credential: {}", e))?;

    Ok(ApiCredential {
        id,
        provider: provider.to_string(),
        name: name.to_string(),
        base_url: base_url.to_string(),
        encrypted_key: encrypted_key.to_string(),
        created_at,
        masked_key: None,
    })
}

pub async fn get_api_credentials(pool: &SqlitePool) -> Result<Vec<ApiCredential>, String> {
    let creds = sqlx::query_as::<_, ApiCredential>(
        r#"
        SELECT id, provider, name, base_url, encrypted_key, created_at
        FROM api_credentials
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch api credentials: {}", e))?;

    Ok(creds)
}

pub async fn get_api_credential_by_id(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<ApiCredential>, String> {
    let cred = sqlx::query_as::<_, ApiCredential>(
        r#"
        SELECT id, provider, name, base_url, encrypted_key, created_at
        FROM api_credentials
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch api credential by id '{}': {}", id, e))?;

    Ok(cred)
}

pub async fn delete_api_credential(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let result = sqlx::query("DELETE FROM api_credentials WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete api credential '{}': {}", id, e))?;

    Ok(result.rows_affected() > 0)
}

// ==========================================
// Local CRM & Funnel State Machine
// ==========================================

pub async fn add_lead(pool: &SqlitePool, input: CreateLeadInput) -> Result<Lead, String> {
    let platform = input.platform.trim().to_lowercase();
    if platform != "vk" && platform != "tg" && platform != "ok" {
        return Err(format!(
            "Invalid lead platform '{}'. Allowed: 'vk', 'tg', 'ok'",
            platform
        ));
    }

    let external_id = input.external_id.trim();
    if external_id.is_empty() {
        return Err("Lead 'external_id' cannot be empty".to_string());
    }

    let name = input.name.trim();
    if name.is_empty() {
        return Err("Lead 'name' cannot be empty".to_string());
    }

    let id = match input.id {
        Some(ref id_str) => {
            Uuid::parse_str(id_str)
                .map_err(|e| format!("Invalid UUID for lead id '{}': {}", id_str, e))?
                .to_string()
        }
        None => Uuid::new_v4().to_string(),
    };

    let funnel_stage = input.funnel_stage.unwrap_or_else(|| "new".to_string());
    let now = chrono::Utc::now().timestamp();
    let created_at = input.created_at.unwrap_or(now);
    let last_interaction_at = input.last_interaction_at.or(Some(now));

    let lead = sqlx::query_as::<_, Lead>(
        r#"
        INSERT INTO leads (id, platform, external_id, name, funnel_stage, last_interaction_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, external_id) DO UPDATE SET
            name = excluded.name,
            funnel_stage = excluded.funnel_stage,
            last_interaction_at = COALESCE(excluded.last_interaction_at, leads.last_interaction_at)
        RETURNING id, platform, external_id, name, funnel_stage, last_interaction_at, created_at
        "#,
    )
    .bind(&id)
    .bind(&platform)
    .bind(external_id)
    .bind(name)
    .bind(&funnel_stage)
    .bind(last_interaction_at)
    .bind(created_at)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to insert or update lead: {}", e))?;

    Ok(lead)
}

pub async fn get_leads(pool: &SqlitePool) -> Result<Vec<Lead>, String> {
    let leads = sqlx::query_as::<_, Lead>(
        r#"
        SELECT id, platform, external_id, name, funnel_stage, last_interaction_at, created_at
        FROM leads
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch leads: {}", e))?;

    Ok(leads)
}

pub async fn get_lead_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Lead>, String> {
    let lead = sqlx::query_as::<_, Lead>(
        r#"
        SELECT id, platform, external_id, name, funnel_stage, last_interaction_at, created_at
        FROM leads
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to fetch lead '{}': {}", id, e))?;

    Ok(lead)
}

pub async fn update_lead_stage(
    pool: &SqlitePool,
    id: &str,
    funnel_stage: &str,
) -> Result<bool, String> {
    let now = chrono::Utc::now().timestamp();
    let result = sqlx::query(
        r#"
        UPDATE leads
        SET funnel_stage = ?, last_interaction_at = ?
        WHERE id = ?
        "#,
    )
    .bind(funnel_stage)
    .bind(now)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update lead stage: {}", e))?;

    Ok(result.rows_affected() > 0)
}

pub async fn update_lead_interaction(
    pool: &SqlitePool,
    id: &str,
    timestamp: i64,
) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE leads
        SET last_interaction_at = ?
        WHERE id = ?
        "#,
    )
    .bind(timestamp)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update lead interaction: {}", e))?;

    Ok(result.rows_affected() > 0)
}

pub async fn delete_lead(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let result = sqlx::query("DELETE FROM leads WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete lead '{}': {}", id, e))?;

    Ok(result.rows_affected() > 0)
}

/// Edge Case - Dead Leads:
/// If a lead has not interacted for 3+ days (259200 seconds), mark as 'cold'.
pub async fn mark_dead_leads_as_cold(pool: &SqlitePool, days: i64) -> Result<u64, String> {
    let threshold = chrono::Utc::now().timestamp() - (days * 86400);
    let result = sqlx::query(
        r#"
        UPDATE leads
        SET funnel_stage = 'cold'
        WHERE last_interaction_at <= ?
          AND funnel_stage NOT IN ('closed', 'cold')
        "#,
    )
    .bind(threshold)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to mark dead leads as cold: {}", e))?;

    Ok(result.rows_affected())
}

/// Aggregated funnel metrics directly from SQLite
/// Invariant: Single aggregation query with COALESCE and zero-division protection
pub async fn get_funnel_metrics(pool: &SqlitePool) -> Result<crate::analytics::FunnelMetrics, String> {
    let row = sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(
        r#"
        SELECT
            COALESCE(COUNT(*), 0) AS total_leads,
            COALESCE(SUM(CASE WHEN funnel_stage = 'request_sent' THEN 1 ELSE 0 END), 0) AS requests_sent,
            COALESCE(SUM(CASE WHEN funnel_stage LIKE 'aida_%' OR funnel_stage LIKE 'spin_%' OR funnel_stage = 'request_accepted' THEN 1 ELSE 0 END), 0) AS dialogs_active,
            COALESCE(SUM(CASE WHEN funnel_stage = 'closed' THEN 1 ELSE 0 END), 0) AS closed,
            COALESCE(SUM(CASE WHEN funnel_stage = 'cold' THEN 1 ELSE 0 END), 0) AS cold
        FROM leads
        "#,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to aggregate funnel metrics: {}", e))?;

    let (total_leads, requests_sent, dialogs_active, closed, cold) = row;
    let conversion_rate = crate::analytics::FunnelMetrics::calculate_conversion_rate(total_leads, closed);

    Ok(crate::analytics::FunnelMetrics {
        total_leads,
        requests_sent,
        dialogs_active,
        closed,
        cold,
        conversion_rate,
    })
}

// ==========================================
// Automation Queue Operations
// ==========================================

pub async fn add_queue_item(
    pool: &SqlitePool,
    id: Option<String>,
    lead_id: &str,
    account_id: &str,
    action_type: &str,
    payload: &str,
    execute_after: i64,
) -> Result<AutomationQueueItem, String> {
    let valid_actions = ["send_friend_request", "send_message", "send_sticker", "check_status"];
    if !valid_actions.contains(&action_type) {
        return Err(format!(
            "Invalid action_type '{}'. Allowed: {:?}",
            action_type, valid_actions
        ));
    }

    let id = match id {
        Some(ref id_str) => {
            Uuid::parse_str(id_str)
                .map_err(|e| format!("Invalid UUID for queue id '{}': {}", id_str, e))?
                .to_string()
        }
        None => Uuid::new_v4().to_string(),
    };

    let created_at = chrono::Utc::now().timestamp();

    sqlx::query(
        r#"
        INSERT INTO automation_queue (id, lead_id, account_id, action_type, payload, execute_after, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
        "#,
    )
    .bind(&id)
    .bind(lead_id)
    .bind(account_id)
    .bind(action_type)
    .bind(payload)
    .bind(execute_after)
    .bind(created_at)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to insert automation queue item: {}", e))?;

    Ok(AutomationQueueItem {
        id,
        lead_id: lead_id.to_string(),
        account_id: account_id.to_string(),
        action_type: action_type.to_string(),
        payload: payload.to_string(),
        execute_after,
        status: "pending".to_string(),
        created_at,
    })
}

pub async fn get_automation_queue(
    pool: &SqlitePool,
) -> Result<Vec<EnrichedAutomationQueueItem>, String> {
    let rows = sqlx::query_as::<_, (String, String, String, String, String, String, String, String, i64, String, i64)>(
        r#"
        SELECT 
            q.id, q.lead_id, l.name as lead_name, l.platform,
            q.account_id, a.name as account_name,
            q.action_type, q.payload, q.execute_after, q.status, q.created_at
        FROM automation_queue q
        JOIN leads l ON q.lead_id = l.id
        JOIN accounts a ON q.account_id = a.id
        ORDER BY q.execute_after ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch automation queue: {}", e))?;

    let items = rows
        .into_iter()
        .map(|(id, lead_id, lead_name, platform, account_id, account_name, action_type, payload, execute_after, status, created_at)| {
            EnrichedAutomationQueueItem {
                id,
                lead_id,
                lead_name,
                platform,
                account_id,
                account_name,
                action_type,
                payload,
                execute_after,
                status,
                created_at,
            }
        })
        .collect();

    Ok(items)
}

pub async fn delete_queue_item(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let result = sqlx::query("DELETE FROM automation_queue WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete queue item '{}': {}", id, e))?;

    Ok(result.rows_affected() > 0)
}

pub async fn get_due_automation_tasks(
    pool: &SqlitePool,
    now: i64,
) -> Result<Vec<AutomationQueueItem>, String> {
    let tasks = sqlx::query_as::<_, AutomationQueueItem>(
        r#"
        SELECT id, lead_id, account_id, action_type, payload, execute_after, status, created_at
        FROM automation_queue
        WHERE status = 'pending' AND execute_after <= ?
        ORDER BY execute_after ASC
        "#,
    )
    .bind(now)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to fetch due automation tasks: {}", e))?;

    Ok(tasks)
}

pub async fn try_lock_queue_task(pool: &SqlitePool, task_id: &str) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE automation_queue
        SET status = 'processing'
        WHERE id = ? AND status = 'pending'
        "#,
    )
    .bind(task_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to lock queue task '{}': {}", task_id, e))?;

    Ok(result.rows_affected() > 0)
}

pub async fn update_queue_task_status(
    pool: &SqlitePool,
    task_id: &str,
    status: &str,
) -> Result<bool, String> {
    let result = sqlx::query(
        r#"
        UPDATE automation_queue
        SET status = ?
        WHERE id = ?
        "#,
    )
    .bind(status)
    .bind(task_id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update queue task status: {}", e))?;

    Ok(result.rows_affected() > 0)
}
