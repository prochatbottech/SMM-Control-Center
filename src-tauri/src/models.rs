use serde::{Deserialize, Serialize};

/// Account entity matching the `accounts` SQLite table
#[derive(Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Account {
    pub id: String,
    pub platform: String,
    pub name: String,
    /// Invariant: NEVER serialize plain or encrypted token to the frontend.
    #[serde(skip_serializing)]
    pub encrypted_token: String,
    pub created_at: i64,
    /// Masked representation for frontend display (e.g. "vk_***123")
    #[serde(skip_deserializing)]
    #[sqlx(default)]
    pub masked_token: Option<String>,
}

impl Account {
    /// Populate `masked_token` for safe frontend display without exposing the real token
    pub fn with_masked_token(mut self) -> Self {
        let suffix = if self.id.len() >= 4 {
            &self.id[..4]
        } else {
            "sec"
        };
        self.masked_token = Some(format!("{}_***{}", self.platform, suffix));
        self
    }
}

/// Invariant: Redact encrypted_token in logs and debug printing
impl std::fmt::Debug for Account {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Account")
            .field("id", &self.id)
            .field("platform", &self.platform)
            .field("name", &self.name)
            .field("encrypted_token", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("masked_token", &self.masked_token)
            .finish()
    }
}

/// Payload for creating a new account.
/// Accepts raw token via `token`, `raw_token`, `plain_token`, or `encrypted_token`.
#[derive(Clone, Serialize)]
pub struct CreateAccountInput {
    pub id: Option<String>,
    pub platform: String,
    pub name: String,
    pub encrypted_token: String,
    pub created_at: Option<i64>,
}

impl<'de> Deserialize<'de> for CreateAccountInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawAccountInput {
            id: Option<String>,
            platform: String,
            name: String,
            #[serde(default)]
            token: Option<String>,
            #[serde(default)]
            raw_token: Option<String>,
            #[serde(default)]
            plain_token: Option<String>,
            #[serde(default)]
            encrypted_token: Option<String>,
            created_at: Option<i64>,
        }

        let raw = RawAccountInput::deserialize(deserializer)?;
        let token_val = raw
            .encrypted_token
            .filter(|s| !s.is_empty())
            .or(raw.token)
            .or(raw.raw_token)
            .or(raw.plain_token)
            .unwrap_or_default();

        Ok(CreateAccountInput {
            id: raw.id,
            platform: raw.platform,
            name: raw.name,
            encrypted_token: token_val,
            created_at: raw.created_at,
        })
    }
}

/// Invariant: Redact plain token in logs and debug printing
impl std::fmt::Debug for CreateAccountInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateAccountInput")
            .field("id", &self.id)
            .field("platform", &self.platform)
            .field("name", &self.name)
            .field("encrypted_token", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// Post status enum values
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PostStatus {
    Draft,
    Scheduled,
    Publishing,
    Published,
    Failed,
    #[serde(rename = "partially_published")]
    PartiallyPublished,
}

impl PostStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            PostStatus::Draft => "draft",
            PostStatus::Scheduled => "scheduled",
            PostStatus::Publishing => "publishing",
            PostStatus::Published => "published",
            PostStatus::Failed => "failed",
            PostStatus::PartiallyPublished => "partially_published",
        }
    }
}

impl std::str::FromStr for PostStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "draft" => Ok(PostStatus::Draft),
            "scheduled" => Ok(PostStatus::Scheduled),
            "publishing" => Ok(PostStatus::Publishing),
            "published" => Ok(PostStatus::Published),
            "failed" => Ok(PostStatus::Failed),
            "partially_published" => Ok(PostStatus::PartiallyPublished),
            _ => Err(format!("Invalid post status: {}", s)),
        }
    }
}

/// Post entity matching the `posts` SQLite table
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PostRow {
    pub id: String,
    pub content: String,
    pub media_urls: String,
    pub status: String,
    pub scheduled_for: Option<i64>,
    pub created_at: i64,
    /// Delivery format: 'post' (regular message) or 'article' (rich message)
    #[sqlx(default)]
    pub format: String,
}

/// Detailed destination account info including status and error log
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DestinationInfo {
    pub account_id: String,
    pub status: String, // 'pending', 'published', 'failed'
    pub error_log: Option<String>,
}

/// Enriched Post representation returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Post {
    pub id: String,
    pub content: String,
    pub media_urls: Vec<String>,
    pub status: String,
    pub scheduled_for: Option<i64>,
    pub created_at: i64,
    /// Delivery format: 'post' (regular) or 'article' (Telegram rich message)
    #[serde(default = "default_post_format")]
    pub format: String,
    pub destination_account_ids: Vec<String>,
    #[serde(default)]
    pub destinations: Vec<DestinationInfo>,
}

fn default_post_format() -> String {
    "post".to_string()
}

/// Payload for creating a new post
#[derive(Debug, Clone, Serialize)]
pub struct CreatePostInput {
    pub id: Option<String>,
    pub content: String,
    pub media_urls: Option<Vec<String>>,
    pub status: Option<String>,
    pub scheduled_for: Option<i64>,
    pub created_at: Option<i64>,
    pub format: Option<String>,
    pub destination_account_ids: Option<Vec<String>>,
}

impl<'de> Deserialize<'de> for CreatePostInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawPostInput {
            id: Option<String>,
            content: String,
            media_urls: Option<Vec<String>>,
            status: Option<String>,
            scheduled_for: Option<i64>,
            created_at: Option<i64>,
            #[serde(default)]
            format: Option<String>,
            #[serde(default)]
            account_ids: Option<Vec<String>>,
            #[serde(default)]
            destination_account_ids: Option<Vec<String>>,
        }

        let raw = RawPostInput::deserialize(deserializer)?;
        let dest_ids = raw
            .destination_account_ids
            .filter(|v| !v.is_empty())
            .or(raw.account_ids);

        Ok(CreatePostInput {
            id: raw.id,
            content: raw.content,
            media_urls: raw.media_urls,
            status: raw.status,
            scheduled_for: raw.scheduled_for,
            created_at: raw.created_at,
            format: raw.format,
            destination_account_ids: dest_ids,
        })
    }
}

/// Many-to-many relationship entity
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PostDestination {
    pub post_id: String,
    pub account_id: String,
    pub status: String,
    pub error_log: Option<String>,
}

/// Helper function to create a masked representation of an API key
pub fn mask_api_key(raw_key: &str) -> String {
    let len = raw_key.len();
    if len <= 7 {
        "***".to_string()
    } else {
        let prefix = &raw_key[..std::cmp::min(3, len)];
        let suffix = &raw_key[len.saturating_sub(4)..];
        format!("{}...{}", prefix, suffix)
    }
}

/// LLM API Credential entity matching `api_credentials` table
#[derive(Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ApiCredential {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub base_url: String,
    /// Invariant: NEVER serialize raw or encrypted key to frontend
    #[serde(skip_serializing)]
    pub encrypted_key: String,
    pub created_at: i64,
    /// Masked representation for frontend display (e.g. "sk-...f3a2")
    #[serde(skip_deserializing)]
    #[sqlx(default)]
    pub masked_key: Option<String>,
}

impl ApiCredential {
    pub fn with_masked_key(mut self, masked: String) -> Self {
        self.masked_key = Some(masked);
        self
    }
}

/// Invariant: Redact encrypted_key in logs and debug printing
impl std::fmt::Debug for ApiCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiCredential")
            .field("id", &self.id)
            .field("provider", &self.provider)
            .field("name", &self.name)
            .field("base_url", &self.base_url)
            .field("encrypted_key", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("masked_key", &self.masked_key)
            .finish()
    }
}

/// Input payload for creating or registering an API Credential
#[derive(Clone, Serialize, Deserialize)]
pub struct CreateApiCredentialInput {
    pub id: Option<String>,
    pub provider: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub created_at: Option<i64>,
}

/// Invariant: Redact raw api_key in logs and debug printing
impl std::fmt::Debug for CreateApiCredentialInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateApiCredentialInput")
            .field("id", &self.id)
            .field("provider", &self.provider)
            .field("name", &self.name)
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .finish()
    }
}

// ==========================================
// Local CRM & Funnel State Machine Models
// ==========================================

/// Lead entity in Local CRM
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Lead {
    pub id: String,
    pub platform: String,
    pub external_id: String,
    pub name: String,
    pub funnel_stage: String,
    pub last_interaction_at: Option<i64>,
    pub created_at: i64,
}

/// Input payload for adding a new lead
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateLeadInput {
    pub id: Option<String>,
    pub platform: String,
    pub external_id: String,
    pub name: String,
    pub funnel_stage: Option<String>,
    pub last_interaction_at: Option<i64>,
    pub created_at: Option<i64>,
}

/// Automation queue item for funnel tasks
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AutomationQueueItem {
    pub id: String,
    pub lead_id: String,
    pub account_id: String,
    pub action_type: String, // 'send_friend_request', 'send_message', 'send_sticker', 'check_status'
    pub payload: String,      // JSON string
    pub execute_after: i64,  // Unix timestamp
    pub status: String,       // 'pending', 'processing', 'completed', 'failed'
    pub created_at: i64,
}

/// Enriched AutomationQueueItem with lead and account info for display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichedAutomationQueueItem {
    pub id: String,
    pub lead_id: String,
    pub lead_name: String,
    pub platform: String,
    pub account_id: String,
    pub account_name: String,
    pub action_type: String,
    pub payload: String,
    pub execute_after: i64,
    pub status: String,
    pub created_at: i64,
}

/// Input for scheduling an action in the automation queue
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleActionInput {
    pub id: Option<String>,
    pub lead_id: String,
    pub account_id: String,
    pub action_type: String,
    pub payload: String,
    /// Explicit timestamp or None to use human-like randomized delay
    pub execute_after: Option<i64>,
    /// Minimum randomized delay in minutes (default: 15)
    pub min_delay_minutes: Option<u32>,
    /// Maximum randomized delay in minutes (default: 45)
    pub max_delay_minutes: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_create_account_with_both_token_and_encrypted_token() {
        let json = r#"{"platform":"tg","name":"Test Bot","token":"my_token_123","encrypted_token":"my_token_123"}"#;
        let parsed: CreateAccountInput = serde_json::from_str(json).expect("Should deserialize without duplicate field error");
        assert_eq!(parsed.platform, "tg");
        assert_eq!(parsed.name, "Test Bot");
        assert_eq!(parsed.encrypted_token, "my_token_123");
    }

    #[test]
    fn test_deserialize_create_post_with_both_account_ids_and_destination_account_ids() {
        let json = r#"{"content":"Test post","account_ids":["acc-1"],"destination_account_ids":["acc-1"]}"#;
        let parsed: CreatePostInput = serde_json::from_str(json).expect("Should deserialize without duplicate field error");
        assert_eq!(parsed.content, "Test post");
        assert_eq!(parsed.destination_account_ids, Some(vec!["acc-1".to_string()]));
    }
}
