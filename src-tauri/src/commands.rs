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

pub const HUMANIZER_PROMPT: &str = "HUMANIZATION RULES: \n\
1. High Burstiness: чередуй короткие (3-5 слов) и длинные (15-20 слов) предложения.\n\
2. High Perplexity: используй непредсказуемую, живую лексику. \n\
3. Banned Words: категорически запрещено использовать слова-маркеры ИИ (delve, tapestry, testament, moreover, furthermore, beacon, crucial, 'в заключение', 'важно отметить'). \n\
4. Тон: пиши как живой человек, допускай легкую неформальность, избегай роботизированного академического стиля.";

/// Helper to assemble the structured system prompt according to routing invariants:
/// [СИСТЕМНАЯ РОЛЬ] -> [HUMANIZATION RULES (если true)] -> [ЗАДАЧА ПОЛЬЗОВАТЕЛЯ: {prompt_instruction}]
pub fn build_rewrite_system_prompt(prompt_instruction: &str, apply_humanizer: bool) -> String {
    let mut parts = vec![
        "Ты профессиональный SMM-копирайтер. Твоя задача — улучшить или переписать предоставленный текст по инструкции пользователя. Сохраняй факты, не добавляй отсебятины и не веди диалог (возвращай ТОЛЬКО финальный текст поста).".to_string()
    ];

    if apply_humanizer {
        parts.push(HUMANIZER_PROMPT.to_string());
    }

    let instruction = prompt_instruction.trim();
    if !instruction.is_empty() {
        parts.push(format!("ЗАДАЧА ПОЛЬЗОВАТЕЛЯ: {}", instruction));
    }

    parts.join("\n\n")
}

/// Tauri Command: Generate AI Rewrite for post text
/// Invariant: Memory safety (zeroize decrypted key), error redaction, meta-prompt enforcement, Humanizer rules.
#[tauri::command]
pub async fn generate_ai_rewrite(
    state: State<'_, DbState>,
    text: String,
    prompt_instruction: String,
    model_name: String,
    credential_id: String,
    apply_humanizer: Option<bool>,
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

    // 3. Assemble system prompt with Humanizer rules if requested
    let humanize = apply_humanizer.unwrap_or(false);
    let sys_prompt = build_rewrite_system_prompt(&prompt_instruction, humanize);

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

/// A VK community (group) the user administers.
#[derive(serde::Serialize)]
pub struct VkCommunity {
    pub id: i64,
    pub name: String,
    pub photo: Option<String>,
}

/// Tauri Command: list VK communities the authorized user administers.
/// Requires a user access token with the `groups` scope.
/// Invariant: token is kept out of error strings; only error_code/error_msg are surfaced.
#[tauri::command]
pub async fn vk_list_communities(token: String) -> Result<Vec<VkCommunity>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "Не удалось инициализировать HTTP-клиент".to_string())?;

    let url = "https://api.vk.com/method/groups.get";
    let params = [
        ("access_token", token.as_str()),
        ("v", "5.199"),
        ("filter", "admin"),
        ("extended", "1"),
        ("fields", "photo_100"),
        ("count", "1000"),
    ];

    let resp = client
        .post(url)
        .form(&params)
        .send()
        .await
        .map_err(|_| "Сетевая ошибка при обращении к VK API".to_string())?;

    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| format!("Некорректный ответ VK API (HTTP {})", status.as_u16()))?;

    if let Some(err) = json.get("error") {
        let code = err.get("error_code").and_then(|v| v.as_i64()).unwrap_or(0);
        let msg = err.get("error_msg").and_then(|v| v.as_str()).unwrap_or("VK error");
        return Err(format!("VK API error {}: {}", code, msg));
    }

    let items = json
        .get("response")
        .and_then(|r| r.get("items"))
        .and_then(|i| i.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::with_capacity(items.len());
    for g in items {
        if let Some(id) = g.get("id").and_then(|v| v.as_i64()) {
            let name = g.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let photo = g.get("photo_100").and_then(|v| v.as_str()).map(|s| s.to_string());
            out.push(VkCommunity { id, name, photo });
        }
    }

    Ok(out)
}

/// Tauri Command: persist the publishing target (community/channel/group) for an account.
#[tauri::command]
pub async fn set_account_target(
    state: State<'_, DbState>,
    id: String,
    auth_type: Option<String>,
    target_id: Option<String>,
    target_title: Option<String>,
    owner_external_id: Option<String>,
) -> Result<bool, String> {
    let auth_type = auth_type.unwrap_or_else(|| "oauth".to_string());
    db::update_account_target(
        &state.pool,
        &id,
        &auth_type,
        target_id.as_deref(),
        target_title.as_deref(),
        owner_external_id.as_deref(),
    )
    .await
}

/// Tauri Command: resolve a VK community from a numeric id, short name or URL.
/// Uses `utils.resolveScreenName` (works even when `groups.get` is restricted).
/// Returns { targetId: "-<group_id>" | "<user_id>", title }.
#[tauri::command]
pub async fn vk_resolve_target(token: String, query: String) -> Result<serde_json::Value, String> {
    let raw = query.trim();
    if raw.is_empty() {
        return Err("Укажите сообщество (ссылку, короткое имя или ID)".to_string());
    }

    // Pure numeric id (or id12345, or -12345) -> treat as community.
    let numeric = raw.trim_start_matches('-');
    let numeric = numeric.strip_prefix("id").unwrap_or(numeric);
    if let Ok(id) = numeric.parse::<i64>() {
        return Ok(serde_json::json!({
            "targetId": format!("-{}", id.abs()),
            "title": format!("Сообщество {}", id.abs())
        }));
    }

    // Strip URL prefixes / leading @ to get a screen name.
    let mut name = raw;
    for p in [
        "https://vk.com/",
        "http://vk.com/",
        "vk.com/",
        "https://m.vk.com/",
        "http://m.vk.com/",
        "m.vk.com/",
        "@",
    ] {
        if let Some(s) = name.strip_prefix(p) {
            name = s;
            break;
        }
    }
    let name = name.trim_matches('/');
    if name.is_empty() {
        return Err("Не удалось разобрать ссылку сообщества".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "Не удалось инициализировать HTTP-клиент".to_string())?;
    let params = [
        ("access_token", token.as_str()),
        ("v", "5.199"),
        ("screen_name", name),
    ];
    let resp = client
        .post("https://api.vk.com/method/utils.resolveScreenName")
        .form(&params)
        .send()
        .await
        .map_err(|_| "Сетевая ошибка при обращении к VK API".to_string())?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| format!("Некорректный ответ VK API (HTTP {})", status.as_u16()))?;

    if let Some(err) = json.get("error") {
        let code = err.get("error_code").and_then(|v| v.as_i64()).unwrap_or(0);
        let msg = err.get("error_msg").and_then(|v| v.as_str()).unwrap_or("VK error");
        return Err(format!("VK API error {}: {}", code, msg));
    }

    let response = json
        .get("response")
        .ok_or_else(|| "VK не вернул response".to_string())?;

    // Not found -> [] (empty array) in some API versions.
    if let Some(arr) = response.as_array() {
        if arr.is_empty() {
            return Err(format!("Сообщество '{}' не найдено", name));
        }
    }

    let oid = response
        .get("object_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| format!("Не удалось определить сообщество '{}'", name))?;
    let typ = response.get("type").and_then(|v| v.as_str()).unwrap_or("");

    let target_id = if typ == "group" {
        format!("-{}", oid)
    } else {
        format!("{}", oid)
    };

    Ok(serde_json::json!({ "targetId": target_id, "title": name }))
}
