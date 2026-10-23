use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::{self, DbState};

/// Funnel metrics aggregating lead lifecycle and conversion rates
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FunnelMetrics {
    pub total_leads: i64,
    pub requests_sent: i64,
    pub dialogs_active: i64,
    pub closed: i64,
    pub cold: i64,
    pub conversion_rate: f64,
}

impl FunnelMetrics {
    pub fn empty() -> Self {
        Self {
            total_leads: 0,
            requests_sent: 0,
            dialogs_active: 0,
            closed: 0,
            cold: 0,
            conversion_rate: 0.0,
        }
    }

    /// Calculate conversion rate safely avoiding division by zero
    pub fn calculate_conversion_rate(total_leads: i64, closed: i64) -> f64 {
        if total_leads <= 0 || closed <= 0 {
            return 0.0;
        }
        let rate = (closed as f64 / total_leads as f64) * 100.0;
        // Round to 2 decimal places
        (rate * 100.0).round() / 100.0
    }
}

/// Tauri Command: Fetch aggregated funnel analytics directly from SQLite
#[tauri::command]
pub async fn get_funnel_analytics(
    state: State<'_, DbState>,
) -> Result<FunnelMetrics, String> {
    db::get_funnel_metrics(&state.pool).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_conversion_rate_safe_division() {
        // Invariant: Division by zero protection
        assert_eq!(FunnelMetrics::calculate_conversion_rate(0, 0), 0.0);
        assert_eq!(FunnelMetrics::calculate_conversion_rate(0, 10), 0.0);
        assert_eq!(FunnelMetrics::calculate_conversion_rate(-5, 0), 0.0);
        assert_eq!(FunnelMetrics::calculate_conversion_rate(100, 0), 0.0);

        // Standard rates
        assert_eq!(FunnelMetrics::calculate_conversion_rate(100, 25), 25.0);
        assert_eq!(FunnelMetrics::calculate_conversion_rate(3, 1), 33.33);
        assert_eq!(FunnelMetrics::calculate_conversion_rate(200, 50), 25.0);
    }

    #[tokio::test]
    async fn test_get_funnel_metrics_empty_db() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();

        sqlx::query(crate::db::MIGRATION_01_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_02_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_03_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_04_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_05_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_06_SQL).execute(&pool).await.unwrap();

        let metrics = db::get_funnel_metrics(&pool).await.unwrap();

        assert_eq!(metrics.total_leads, 0);
        assert_eq!(metrics.requests_sent, 0);
        assert_eq!(metrics.dialogs_active, 0);
        assert_eq!(metrics.closed, 0);
        assert_eq!(metrics.cold, 0);
        assert_eq!(metrics.conversion_rate, 0.0);
    }

    #[tokio::test]
    async fn test_get_funnel_metrics_aggregation_and_conversion() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .unwrap();

        sqlx::query(crate::db::MIGRATION_01_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_02_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_03_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_04_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_05_SQL).execute(&pool).await.unwrap();
        sqlx::query(crate::db::MIGRATION_06_SQL).execute(&pool).await.unwrap();

        // 10 leads:
        // 2 request_sent
        // 2 aida_attention + 1 spin_problem + 1 request_accepted = 4 dialogs_active
        // 2 closed
        // 1 cold
        // 1 new
        let stages = [
            "request_sent", "request_sent",
            "aida_attention", "aida_interest", "spin_problem", "request_accepted",
            "closed", "closed",
            "cold",
            "new",
        ];

        for (i, stage) in stages.iter().enumerate() {
            db::add_lead(
                &pool,
                crate::models::CreateLeadInput {
                    id: None,
                    platform: "vk".to_string(),
                    external_id: format!("vk_{}", i),
                    name: format!("Lead {}", i),
                    funnel_stage: Some(stage.to_string()),
                    last_interaction_at: None,
                    created_at: None,
                },
            )
            .await
            .unwrap();
        }

        let metrics = db::get_funnel_metrics(&pool).await.unwrap();

        assert_eq!(metrics.total_leads, 10);
        assert_eq!(metrics.requests_sent, 2);
        assert_eq!(metrics.dialogs_active, 4);
        assert_eq!(metrics.closed, 2);
        assert_eq!(metrics.cold, 1);
        // 2 closed out of 10 leads = 20.0%
        assert_eq!(metrics.conversion_rate, 20.0);
    }
}
