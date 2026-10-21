use tauri::State;
use serde_json::Value as JsonValue;
use zeroize::{Zeroize, Zeroizing};
use crate::crypto;
use crate::db::{self, DbState};
use crate::llm_gateway;
use crate::models::{self, CreateAccountInput, CreateApiCredentialInput, CreatePostInput};

/// Tauri Command: Create a new account
/// Invariant: Plain token is encrypted via AES-256-GCM before writing to SQLite.
/// Output is masked with `#[serde(skip_serializing)]` on the encrypted token field.
#[tauri::command]
pub async fn create_account(
    state: State<'_, DbState>,
    input: CreateAccountInput,
) -> Result<JsonValue, String> {
    // 1. Obtain master key from OS Keyring
    let key = crypto::get_or_generate_key().map_err(|e| e.to_string())?;

    // 2. Encrypt the raw token with a unique 12-byte Nonce
    let encrypted = crypto::encrypt_token(&input.encrypted_token, &key).map_err(|e| e.to_string())?;

    // 3. Prepare payload for DB insertion
    let mut db_input = input;
    db_input.encrypted_token = encrypted;

    // 4. Save to database
    let account = db::create_account(&state.pool, db_input).await?;

    // 5. Mask token for frontend response
    let safe_account = account.with_masked_token();

    serde_json::to_value(&safe_account).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Retrieve all accounts
/// Invariant: Frontend isolation: Real token is excluded from serialization (`#[serde(skip_serializing)]`)
/// and a safe mask is provided.
#[tauri::command]
pub async fn get_accounts(state: State<'_, DbState>) -> Result<JsonValue, String> {
    let accounts = db::get_accounts(&state.pool).await?;
    let safe_accounts: Vec<_> = accounts
        .into_iter()
        .map(|acc| acc.with_masked_token())
        .collect();

    serde_json::to_value(&safe_accounts).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Retrieve an account by its UUID
/// Invariant: Frontend isolation: Token is never sent to frontend.
#[tauri::command]
pub async fn get_account_by_id(
    state: State<'_, DbState>,
    id: String,
) -> Result<JsonValue, String> {
    let maybe_account = db::get_account_by_id(&state.pool, &id).await?;
    let safe_account = maybe_account.map(|acc| acc.with_masked_token());

    serde_json::to_value(&safe_account).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Delete an account by UUID
/// Invariant: Cascade deletes associated entries in post_destinations
#[tauri::command]
pub async fn delete_account(
    state: State<'_, DbState>,
    id: String,
) -> Result<JsonValue, String> {
    let deleted = db::delete_account(&state.pool, &id).await?;
    Ok(serde_json::json!({
        "deleted": deleted,
        "id": id
    }))
}

/// Tauri Command: Create a new post
#[tauri::command]
pub async fn create_post(
    state: State<'_, DbState>,
    input: CreatePostInput,
) -> Result<JsonValue, String> {
    let post = db::create_post(&state.pool, input).await?;
    serde_json::to_value(&post).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Retrieve all posts
#[tauri::command]
pub async fn get_posts(state: State<'_, DbState>) -> Result<JsonValue, String> {
    let posts = db::get_posts(&state.pool).await?;
    serde_json::to_value(&posts).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Delete a post by UUID
#[tauri::command]
pub async fn delete_post(
    state: State<'_, DbState>,
    id: String,
) -> Result<JsonValue, String> {
    let deleted = db::delete_post(&state.pool, &id).await?;
    Ok(serde_json::json!({
        "deleted": deleted,
        "id": id
    }))
}

/// Tauri Command: Retry a failed or partially published post
#[tauri::command]
pub async fn retry_post(
    state: State<'_, DbState>,
    id: String,
) -> Result<JsonValue, String> {
    db::retry_post(&state.pool, &id).await?;
    let maybe_post = db::get_post_by_id(&state.pool, &id).await?;
    let post = maybe_post.ok_or_else(|| format!("Post '{}' not found", id))?;
    serde_json::to_value(&post).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Parse content source (RSS/Atom feed or HTML OpenGraph)
/// Invariant: Storage isolation: Does not write to DB, returns parsed items directly to frontend.
#[tauri::command]
pub async fn parse_content_source(url: String) -> Result<Vec<crate::parser::ParsedItem>, String> {
    crate::parser::parse_content_source(&url).await
}

// ==========================================
// LLM API Credentials & AI Commands
// ==========================================

/// Tauri Command: Register or create an API Credential
/// Invariant: Plain API key is encrypted via AES-256-GCM before writing to SQLite.
/// Output has masked_key populated; encrypted_key is excluded from frontend serialization.
#[tauri::command]
pub async fn create_api_credential(
    state: State<'_, DbState>,
    input: CreateApiCredentialInput,
) -> Result<JsonValue, String> {
    let mut raw_key = Zeroizing::new(input.api_key.trim().to_string());
    if raw_key.is_empty() {
        return Err("API key cannot be empty".to_string());
    }

    let mask = models::mask_api_key(&raw_key);

    let master_key = crypto::get_or_generate_key().map_err(|e| e.to_string())?;
    let encrypted = crypto::encrypt_token(&raw_key, &master_key).map_err(|e| e.to_string())?;

    // Zeroize plain key from memory
    raw_key.zeroize();

    let cred = db::create_api_credential(
        &state.pool,
        input.id,
        &input.provider,
        &input.name,
        &input.base_url,
        &encrypted,
        input.created_at,
    )
    .await?;

    let safe_cred = cred.with_masked_key(mask);
    serde_json::to_value(&safe_cred).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Retrieve all registered API Credentials
/// Invariant: Frontend isolation: real and encrypted keys are NEVER sent to the frontend.
/// Decrypts in memory only to compute masked_key and zeroizes memory immediately.
#[tauri::command]
pub async fn get_api_credentials(state: State<'_, DbState>) -> Result<JsonValue, String> {
    let creds = db::get_api_credentials(&state.pool).await?;
    let master_key = crypto::get_or_generate_key().map_err(|e| e.to_string())?;

    let mut safe_creds = Vec::with_capacity(creds.len());
    for cred in creds {
        let mask = match crypto::decrypt_token(&cred.encrypted_key, &master_key) {
            Ok(mut decrypted) => {
                let m = models::mask_api_key(&decrypted);
                decrypted.zeroize();
                m
            }
            Err(_) => "***".to_string(),
        };

        safe_creds.push(cred.with_masked_key(mask));
    }

    serde_json::to_value(&safe_creds).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Delete an API Credential by UUID
#[tauri::command]
pub async fn delete_api_credential(
    state: State<'_, DbState>,
    id: String,
) -> Result<JsonValue, String> {
    let deleted = db::delete_api_credential(&state.pool, &id).await?;
    Ok(serde_json::json!({
        "deleted": deleted,
        "id": id
    }))
}

/// Tauri Command: Generate AI Rewrite for post text
/// Invariant: Memory safety (zeroize decrypted key), error redaction, meta-prompt enforcement.
#[tauri::command]
pub async fn generate_ai_rewrite(
    state: State<'_, DbState>,
    text: String,
    prompt_instruction: String,
    model_name: String,
    credential_id: String,
) -> Result<String, String> {
    let user_text = text.trim();
    if user_text.is_empty() {
        return Err("Текст для обработки не может быть пустым".to_string());
    }

    let model = model_name.trim();
    if model.is_empty() {
        return Err("Название модели не может быть пустым".to_string());
    }

    // 1. Fetch credential
    let maybe_cred = db::get_api_credential_by_id(&state.pool, &credential_id).await?;
    let cred = maybe_cred.ok_or_else(|| format!("API Credential '{}' not found", credential_id))?;

    // 2. Decrypt API Key
    let master_key = crypto::get_or_generate_key().map_err(|e| e.to_string())?;
    let decrypted = crypto::decrypt_token(&cred.encrypted_key, &master_key)
        .map_err(|e| format!("Failed to decrypt API key: {}", e))?;
    let raw_key = Zeroizing::new(decrypted);

    // 3. System meta-prompt
    let base_meta_prompt = "Ты профессиональный SMM-копирайтер. Твоя задача — улучшить или переписать предоставленный текст по инструкции пользователя. Сохраняй факты, не добавляй отсебятины и не веди диалог (возвращай ТОЛЬКО финальный текст поста).";
    let sys_prompt = if prompt_instruction.trim().is_empty() {
        base_meta_prompt.to_string()
    } else {
        format!("{}\nИнструкция: {}", base_meta_prompt, prompt_instruction.trim())
    };

    // 4. Invoke LLM Gateway
    llm_gateway::send_completion(
        &cred.provider,
        &cred.base_url,
        raw_key,
        model,
        &sys_prompt,
        user_text,
    )
    .await
}
