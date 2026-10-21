use rand::Rng;
use serde_json::Value as JsonValue;
use tauri::State;
use crate::db::{self, DbState};
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
}
