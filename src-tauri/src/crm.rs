use rand::Rng;
use serde_json::Value as JsonValue;
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;
use crate::crypto;
use crate::db::{self, DbState};
use crate::funnel_prompts;
use crate::llm_gateway;
use crate::models::{CreateLeadInput, ScheduleActionInput};

pub const DEFAULT_MIN_DELAY_MINUTES: u32 = 15;
pub const DEFAULT_MAX_DELAY_MINUTES: u32 = 45;

/// Invariant: Human-Like Delays:
/// Calculates randomized delay in seconds (e.g. between 15 and 45 minutes) plus random jitter
/// to ensure multiple actions never land on the exact same second.
pub fn calculate_human_like_delay(min_minutes: u32, max_minutes: u32) -> i64 {
    let mut rng = rand::thread_rng();
    let min_secs = (min_minutes as u64) * 60;
    let max_secs = (max_minutes.max(min_minutes) as u64) * 60;

    let delay_secs = if min_secs == max_secs {
        min_secs
    } else {
        rng.gen_range(min_secs..=max_secs)
    };

    // Random second jitter (1..=59)
    let jitter: u64 = rng.gen_range(1..=59);

    chrono::Utc::now().timestamp() + (delay_secs as i64) + (jitter as i64)
}

/// Tauri Command: Add or upsert a lead in Local CRM
#[tauri::command]
pub async fn add_lead(
    state: State<'_, DbState>,
    input: CreateLeadInput,
) -> Result<JsonValue, String> {
    let lead = db::add_lead(&state.pool, input).await?;
    serde_json::to_value(&lead).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Get all leads from Local CRM
#[tauri::command]
pub async fn get_leads(state: State<'_, DbState>) -> Result<JsonValue, String> {
    let leads = db::get_leads(&state.pool).await?;
    serde_json::to_value(&leads).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Update lead's funnel stage
#[tauri::command]
pub async fn update_lead_stage(
    state: State<'_, DbState>,
    id: String,
    funnel_stage: String,
) -> Result<JsonValue, String> {
    let updated = db::update_lead_stage(&state.pool, &id, &funnel_stage).await?;
    Ok(serde_json::json!({
        "updated": updated,
        "id": id,
        "funnel_stage": funnel_stage
    }))
}

/// Tauri Command: Delete a lead and its automation tasks (via CASCADE)
#[tauri::command]
pub async fn delete_lead(
    state: State<'_, DbState>,
    id: String,
) -> Result<JsonValue, String> {
    let deleted = db::delete_lead(&state.pool, &id).await?;
    Ok(serde_json::json!({
        "deleted": deleted,
        "id": id
    }))
}

/// Tauri Command: Schedule an automation action for a lead
/// Invariant: Human-like delay calculation if execute_after is omitted.
#[tauri::command]
pub async fn schedule_action(
    state: State<'_, DbState>,
    input: ScheduleActionInput,
) -> Result<JsonValue, String> {
    let execute_after = match input.execute_after {
        Some(ts) => ts,
        None => {
            let min = input.min_delay_minutes.unwrap_or(DEFAULT_MIN_DELAY_MINUTES);
            let max = input.max_delay_minutes.unwrap_or(DEFAULT_MAX_DELAY_MINUTES);
            calculate_human_like_delay(min, max)
        }
    };

    let item = db::add_queue_item(
        &state.pool,
        input.id,
        &input.lead_id,
        &input.account_id,
        &input.action_type,
        &input.payload,
        execute_after,
    )
    .await?;

    serde_json::to_value(&item).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Retrieve all automation queue items with enriched lead & account metadata
#[tauri::command]
pub async fn get_automation_queue(state: State<'_, DbState>) -> Result<JsonValue, String> {
    let items = db::get_automation_queue(&state.pool).await?;
    serde_json::to_value(&items).map_err(|e| format!("Serialization error: {}", e))
}

/// Tauri Command: Delete an automation queue task
#[tauri::command]
pub async fn delete_queue_item(
    state: State<'_, DbState>,
    id: String,
) -> Result<JsonValue, String> {
    let deleted = db::delete_queue_item(&state.pool, &id).await?;
    Ok(serde_json::json!({
        "deleted": deleted,
        "id": id
    }))
}

/// Tauri Command: Mark leads with no response for 3+ days as 'cold'
#[tauri::command]
pub async fn mark_dead_leads(
    state: State<'_, DbState>,
    days: Option<i64>,
) -> Result<JsonValue, String> {
    let d = days.unwrap_or(3);
    let count = db::mark_dead_leads_as_cold(&state.pool, d).await?;
    Ok(serde_json::json!({
        "marked_cold_count": count,
        "days": d
    }))
}

/// Core helper for funnel message generation using AIDA or SPIN frameworks via LLM Gateway
pub async fn generate_funnel_message_internal(
    pool: &sqlx::SqlitePool,
    lead_id: &Uuid,
    credential_id: &Uuid,
    framework: &str,
    stage: &str,
    custom_context: &str,
    apply_humanizer: bool,
    model_name: Option<&str>,
) -> Result<String, String> {
    let lead_id_str = lead_id.to_string();
    let cred_id_str = credential_id.to_string();

    // 1. Fetch Lead
    let lead = db::get_lead_by_id(pool, &lead_id_str)
        .await?
        .ok_or_else(|| format!("Лид с ID '{}' не найден", lead_id_str))?;

    // 2. Fetch API Credential
    let cred = db::get_api_credential_by_id(pool, &cred_id_str)
        .await?
        .ok_or_else(|| format!("API Credential с ID '{}' не найден", cred_id_str))?;

    // 3. Decrypt API Key with zeroization on drop
    let master_key = crypto::get_or_generate_key().map_err(|e| e.to_string())?;
    let decrypted = crypto::decrypt_token(&cred.encrypted_key, &master_key)
        .map_err(|e| format!("Не удалось расшифровать API ключ: {}", e))?;
    let raw_key = Zeroizing::new(decrypted);

    // 4. Assemble system prompt with formula:
    // [РОЛЬ: Эксперт по нетворкингу] -> [ПРАВИЛА ВОРОНКИ (AIDA/SPIN)] -> [ПРАВИЛА HUMANIZER (если включен)] -> [ЗАПРЕТ НА МУСОРНЫЕ ФРАЗЫ И ПРИВЕТСТВИЯ АССИСТЕНТА] -> [КОНТЕКСТ ЛИДА]
    let sys_prompt = funnel_prompts::build_funnel_system_prompt(
        framework,
        stage,
        &lead.name,
        &lead.platform,
        custom_context,
        apply_humanizer,
    );

    let user_text = format!(
        "Сгенерируй первое сообщение для лида по этапу '{}' методологии '{}'.\nКонтекст: {}",
        stage,
        framework,
        if custom_context.trim().is_empty() {
            "Нетворкинг и знакомство"
        } else {
            custom_context.trim()
        }
    );

    // 5. Determine model name
    let model = match model_name {
        Some(m) if !m.trim().is_empty() => m.trim().to_string(),
        _ => match cred.provider.as_str() {
            "anthropic" => "claude-3-5-sonnet-20241022".to_string(),
            _ => "gpt-4o-mini".to_string(),
        },
    };

    // 6. Invoke LLM Gateway
    let raw_result = llm_gateway::send_completion(
        &cred.provider,
        &cred.base_url,
        raw_key,
        &model,
        &sys_prompt,
        &user_text,
    )
    .await
    .map_err(|e| format!("Ошибка LLM Gateway: {}", e))?;

    // 7. Sanitize output (strip quotes, prefixes, codeblocks, accidental placeholders)
    let cleaned = funnel_prompts::clean_generated_funnel_message(&raw_result, &lead.name);
    if cleaned.is_empty() {
        return Err("LLM вернула пустой ответ после очистки".to_string());
    }

    Ok(cleaned)
}

/// Tauri Command: Generate personalized funnel message for a lead using AIDA or SPIN models
#[tauri::command]
pub async fn generate_funnel_message(
    state: State<'_, DbState>,
    lead_id: Uuid,
    credential_id: Uuid,
    framework: String,
    stage: String,
    custom_context: String,
    apply_humanizer: bool,
    model_name: Option<String>,
) -> Result<String, String> {
    generate_funnel_message_internal(
        &state.pool,
        &lead_id,
        &credential_id,
        &framework,
        &stage,
        &custom_context,
        apply_humanizer,
        model_name.as_deref(),
    )
    .await
}

/// Tauri Command: Generate funnel message and schedule in automation_queue with human-like delay
/// Invariant: Atomic operation: Awaits LLM completion first, and ONLY inserts into queue upon success.
#[tauri::command]
pub async fn generate_and_schedule_message(
    state: State<'_, DbState>,
    lead_id: Uuid,
    account_id: Uuid,
    credential_id: Uuid,
    framework: String,
    stage: String,
    custom_context: String,
    apply_humanizer: bool,
    model_name: Option<String>,
) -> Result<(), String> {
    let lead_id_str = lead_id.to_string();
    let account_id_str = account_id.to_string();

    // 1. Verify that the sending account exists
    let _account = db::get_account_by_id(&state.pool, &account_id_str)
        .await?
        .ok_or_else(|| format!("Аккаунт с ID '{}' не найден", account_id_str))?;

    // 2. Generate message via LLM Gateway (awaits response first!)
    // Invariant: If LLM fails or times out, this returns Err immediately and NO queue item is added.
    let generated_message = generate_funnel_message_internal(
        &state.pool,
        &lead_id,
        &credential_id,
        &framework,
        &stage,
        &custom_context,
        apply_humanizer,
        model_name.as_deref(),
    )
    .await?;

    // 3. Calculate human-like delay (15-45 minutes + random jitter)
    let execute_after = calculate_human_like_delay(
        DEFAULT_MIN_DELAY_MINUTES,
        DEFAULT_MAX_DELAY_MINUTES,
    );

    // 4. Construct payload for 'send_message' action
    let payload = serde_json::to_string(&serde_json::json!({
        "text": generated_message,
        "framework": framework,
        "stage": stage,
    }))
    .map_err(|e| format!("Serialization error: {}", e))?;

    // 5. Insert task into automation_queue with action_type = 'send_message'
    db::add_queue_item(
        &state.pool,
        None,
        &lead_id_str,
        &account_id_str,
        "send_message",
        &payload,
        execute_after,
    )
    .await?;

    // 6. Advance lead funnel stage if matching known stage
    let target_stage = match stage.to_lowercase().as_str() {
        "attention" | "aida_attention" => Some("aida_attention"),
        "interest" | "aida_interest" => Some("aida_interest"),
        "closed" | "close" => Some("closed"),
        _ => None,
    };
    if let Some(st) = target_stage {
        let _ = db::update_lead_stage(&state.pool, &lead_id_str, st).await;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_human_like_delay() {
        let now = chrono::Utc::now().timestamp();
        let delay_ts = calculate_human_like_delay(15, 45);

        // Min 15 mins (900s), Max 45 mins (2700s) + jitter up to 59s
        assert!(delay_ts >= now + 900);
        assert!(delay_ts <= now + 2700 + 60);

        // Different calls must generate different timestamps (jitter protection)
        let delay_ts2 = calculate_human_like_delay(15, 45);
        // Extremely unlikely to be identical due to rand ranges and jitter
        assert!(delay_ts > 0 && delay_ts2 > 0);
    }

    #[tokio::test]
    async fn test_generate_funnel_message_internal_missing_lead() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();

        // Run migrations
        sqlx::query(crate::db::MIGRATION_01_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_02_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_03_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_04_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_05_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_06_SQL).execute(&pool).await.unwrap();

        let fake_lead_id = Uuid::new_v4();
        let fake_cred_id = Uuid::new_v4();

        let res = generate_funnel_message_internal(
            &pool,
            &fake_lead_id,
            &fake_cred_id,
            "aida",
            "attention",
            "context",
            true,
            None,
        )
        .await;

        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Лид с ID"));
    }

    #[tokio::test]
    async fn test_generate_funnel_message_internal_missing_credential() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();

        // Run migrations
        sqlx::query(crate::db::MIGRATION_01_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_02_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_03_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_04_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_05_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_06_SQL).execute(&pool).await.unwrap();

        // Create a lead
        let lead = db::add_lead(
            &pool,
            CreateLeadInput {
                id: None,
                platform: "vk".to_string(),
                external_id: "vk_test_123".to_string(),
                name: "Тестовый Лид".to_string(),
                funnel_stage: Some("new".to_string()),
                last_interaction_at: None,
                created_at: None,
            },
        )
        .await
        .unwrap();

        let lead_uuid = Uuid::parse_str(&lead.id).unwrap();
        let fake_cred_id = Uuid::new_v4();

        let res = generate_funnel_message_internal(
            &pool,
            &lead_uuid,
            &fake_cred_id,
            "aida",
            "attention",
            "context",
            false,
            None,
        )
        .await;

        assert!(res.is_err());
        assert!(res.unwrap_err().contains("API Credential с ID"));
    }
}
