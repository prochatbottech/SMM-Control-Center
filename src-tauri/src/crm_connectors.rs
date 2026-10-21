use std::time::Duration;
use rand::Rng;
use reqwest::StatusCode;
use serde_json::Value as JsonValue;

const DEFAULT_HTTP_TIMEOUT_SECS: u64 = 10;

/// Parsed VK API error representation
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VkApiError {
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for VkApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "VK API error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for VkApiError {}

/// Generates a non-zero random 32-bit integer for VK messages.send random_id
/// Invariant: VK requires random_id to prevent duplicate messages across network retries.
pub fn generate_vk_random_id() -> i32 {
    let mut rng = rand::thread_rng();
    rng.gen_range(1..=i32::MAX)
}

/// Normalizes VK lead identifier or URL.
/// Returns (Option<numeric_user_id>, domain_or_raw_string).
/// Examples:
/// - "12345" -> (Some(12345), "12345")
/// - "id12345" -> (Some(12345), "12345")
/// - "https://vk.com/durov" -> (None, "durov")
/// - "durov" -> (None, "durov")
pub fn clean_vk_id_or_domain(raw: &str) -> (Option<i64>, String) {
    let mut cleaned = raw.trim();

    for prefix in &[
        "https://vk.com/",
        "http://vk.com/",
        "vk.com/",
        "https://m.vk.com/",
        "http://m.vk.com/",
        "m.vk.com/",
    ] {
        if let Some(stripped) = cleaned.strip_prefix(prefix) {
            cleaned = stripped;
            break;
        }
    }

    cleaned = cleaned.trim_matches('/');

    // If starts with "id" followed by digits
    if let Some(id_part) = cleaned.strip_prefix("id") {
        if let Ok(num) = id_part.parse::<i64>() {
            return (Some(num), id_part.to_string());
        }
    }

    // If purely digits
    if let Ok(num) = cleaned.parse::<i64>() {
        return (Some(num), cleaned.to_string());
    }

    (None, cleaned.to_string())
}

/// Extracts plain text message from task payload.
/// Payload can be either a JSON string (e.g. `{"text": "..."}`) or plain text.
pub fn extract_payload_text(payload: &str) -> String {
    let trimmed = payload.trim();
    if let Ok(val) = serde_json::from_str::<JsonValue>(trimmed) {
        if let Some(t) = val.get("text").and_then(|v| v.as_str()) {
            return t.to_string();
        }
        if let Some(m) = val.get("message").and_then(|v| v.as_str()) {
            return m.to_string();
        }
    }
    trimmed.to_string()
}

/// Parses VKontakte JSON API response.
/// Invariant: Security & Zero-Secret: Never log or return `request_params` as it leaks the access_token.
pub fn parse_vk_api_response(
    status: StatusCode,
    body_json: &JsonValue,
) -> Result<String, VkApiError> {
    if let Some(error_obj) = body_json.get("error") {
        let code = error_obj
            .get("error_code")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let msg = error_obj
            .get("error_msg")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown VK error");

        return Err(VkApiError {
            code,
            message: msg.to_string(),
        });
    }

    if !status.is_success() {
        return Err(VkApiError {
            code: status.as_u16() as i64,
            message: format!("HTTP error {}", status.as_u16()),
        });
    }

    // Success response parsing
    if let Some(resp) = body_json.get("response") {
        if let Some(num) = resp.as_i64() {
            return Ok(num.to_string());
        }
        if let Some(s) = resp.as_str() {
            return Ok(s.to_string());
        }
        return Ok(resp.to_string());
    }

    Ok("ok".to_string())
}

/// Parses Telegram Bot API response.
pub fn parse_tg_api_response(
    status: StatusCode,
    body_json: &JsonValue,
) -> Result<String, String> {
    if let Some(ok) = body_json.get("ok").and_then(|v| v.as_bool()) {
        if !ok {
            let desc = body_json
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown Telegram API error");
            return Err(format!("Telegram API error: {}", desc));
        }
    } else if !status.is_success() {
        return Err(format!("Telegram API returned HTTP status {}", status.as_u16()));
    }

    if let Some(msg_id) = body_json
        .get("result")
        .and_then(|r| r.get("message_id"))
        .and_then(|m| m.as_i64())
    {
        Ok(format!("msg_{}", msg_id))
    } else {
        Ok("ok".to_string())
    }
}

/// Executes a VK action (friends.add or messages.send).
/// Invariants:
/// - POST form-urlencoded to keep access_token in request body.
/// - random_id 32-bit integer for messages.send.
/// - Network error masking so access_token is never leaked in log or error strings.
pub async fn execute_vk_action(
    client: &reqwest::Client,
    base_url: Option<&str>,
    token: &str,
    external_id: &str,
    action_type: &str,
    payload: &str,
) -> Result<String, String> {
    let base = base_url.unwrap_or("https://api.vk.com").trim_end_matches('/');
    let (maybe_user_id, domain) = clean_vk_id_or_domain(external_id);
    let message_text = extract_payload_text(payload);

    match action_type {
        "send_friend_request" => {
            let url = format!("{}/method/friends.add", base);
            let user_id_str = match maybe_user_id {
                Some(id) => id.to_string(),
                None => {
                    return Err(format!(
                        "Для отправки заявки в друзья VK требуется числовой ID пользователя (например id12345678). Получено: '{}'",
                        external_id
                    ));
                }
            };

            let mut form_params: Vec<(&str, &str)> = vec![
                ("v", "5.199"),
                ("access_token", token),
                ("user_id", &user_id_str),
            ];

            if !message_text.is_empty() {
                form_params.push(("text", &message_text));
            }

            let resp = match client.post(&url).form(&form_params).send().await {
                Ok(r) => r,
                Err(_) => return Err("Network or API connection error while calling VK API".to_string()),
            };

            let status = resp.status();
            let body_json: JsonValue = match resp.json().await {
                Ok(j) => j,
                Err(_) => {
                    return Err(format!("Invalid response format from VK API (status {})", status.as_u16()));
                }
            };

            parse_vk_api_response(status, &body_json).map_err(|e| e.to_string())
        }
        "send_message" => {
            let url = format!("{}/method/messages.send", base);
            let random_id_str = generate_vk_random_id().to_string();
            let user_id_str = maybe_user_id.map(|id| id.to_string());

            let mut form_params: Vec<(&str, &str)> = vec![
                ("v", "5.199"),
                ("access_token", token),
                ("random_id", &random_id_str),
                ("message", &message_text),
            ];

            if let Some(ref uid) = user_id_str {
                form_params.push(("user_id", uid));
            } else {
                form_params.push(("domain", &domain));
            }

            let resp = match client.post(&url).form(&form_params).send().await {
                Ok(r) => r,
                Err(_) => return Err("Network or API connection error while calling VK API".to_string()),
            };

            let status = resp.status();
            let body_json: JsonValue = match resp.json().await {
                Ok(j) => j,
                Err(_) => {
                    return Err(format!("Invalid response format from VK API (status {})", status.as_u16()));
                }
            };

            parse_vk_api_response(status, &body_json).map_err(|e| e.to_string())
        }
        unsupported => Err(format!(
            "Действие '{}' не поддерживается коннектором VK (поддерживаются: send_friend_request, send_message)",
            unsupported
        )),
    }
}

/// Executes a Telegram action via Bot API.
/// Invariants:
/// - POST to /bot{token}/sendMessage with JSON body.
/// - Token is masked from errors.
pub async fn execute_tg_action(
    client: &reqwest::Client,
    base_url: Option<&str>,
    token: &str,
    external_id: &str,
    action_type: &str,
    payload: &str,
) -> Result<String, String> {
    let base = base_url.unwrap_or("https://api.telegram.org").trim_end_matches('/');

    match action_type {
        "send_friend_request" => Err(
            "Telegram Bot API не поддерживает заявки в друзья (массфрендинг доступен только через VK или MTProto)"
                .to_string(),
        ),
        "send_message" => {
            let url = format!("{}/bot{}/sendMessage", base, token);
            let message_text = extract_payload_text(payload);
            let chat_id = crate::publisher::normalize_telegram_chat_id(external_id);

            let body = serde_json::json!({
                "chat_id": chat_id,
                "text": message_text,
            });

            let resp = match client.post(&url).json(&body).send().await {
                Ok(r) => r,
                Err(_) => return Err("Network or API connection error while calling Telegram API".to_string()),
            };

            let status = resp.status();
            let body_json: JsonValue = match resp.json().await {
                Ok(j) => j,
                Err(_) => {
                    return Err(format!("Invalid response format from Telegram API (status {})", status.as_u16()));
                }
            };

            parse_tg_api_response(status, &body_json)
        }
        unsupported => Err(format!(
            "Действие '{}' не поддерживается коннектором Telegram",
            unsupported
        )),
    }
}

/// Helper to create a shared HTTP client with timeout for CRM actions
pub fn create_crm_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(DEFAULT_HTTP_TIMEOUT_SECS))
        .build()
        .expect("Failed to initialize reqwest Client for CRM connectors")
}

/// Trait defining the connector interface for executing CRM actions (friends.add, messages.send, etc.)
pub trait CrmConnector: Send + Sync {
    fn execute_action(
        &self,
        platform: &str,
        token: &str,
        external_id: &str,
        action_type: &str,
        payload: &str,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
}

/// Production implementation of CrmConnector using reqwest
#[derive(Clone)]
pub struct RealCrmConnector {
    pub client: reqwest::Client,
    pub vk_base_url: Option<String>,
    pub tg_base_url: Option<String>,
}

impl RealCrmConnector {
    pub fn new() -> Self {
        Self {
            client: create_crm_http_client(),
            vk_base_url: None,
            tg_base_url: None,
        }
    }

    pub fn with_endpoints(vk_base_url: Option<String>, tg_base_url: Option<String>) -> Self {
        Self {
            client: create_crm_http_client(),
            vk_base_url,
            tg_base_url,
        }
    }
}

impl Default for RealCrmConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl CrmConnector for RealCrmConnector {
    async fn execute_action(
        &self,
        platform: &str,
        token: &str,
        external_id: &str,
        action_type: &str,
        payload: &str,
    ) -> Result<String, String> {
        match platform.to_lowercase().as_str() {
            "vk" => {
                execute_vk_action(
                    &self.client,
                    self.vk_base_url.as_deref(),
                    token,
                    external_id,
                    action_type,
                    payload,
                )
                .await
            }
            "tg" | "telegram" => {
                execute_tg_action(
                    &self.client,
                    self.tg_base_url.as_deref(),
                    token,
                    external_id,
                    action_type,
                    payload,
                )
                .await
            }
            other => Err(format!(
                "Платформа '{}' не поддерживается исполнительным слоем CRM",
                other
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_vk_random_id_is_positive_and_nonzero() {
        for _ in 0..100 {
            let id = generate_vk_random_id();
            assert!(id > 0, "random_id must be positive and non-zero");
        }
    }

    #[test]
    fn test_clean_vk_id_or_domain() {
        assert_eq!(clean_vk_id_or_domain("123456"), (Some(123456), "123456".to_string()));
        assert_eq!(clean_vk_id_or_domain("id98765"), (Some(98765), "98765".to_string()));
        assert_eq!(clean_vk_id_or_domain("https://vk.com/id112233"), (Some(112233), "112233".to_string()));
        assert_eq!(clean_vk_id_or_domain("https://vk.com/durov"), (None, "durov".to_string()));
        assert_eq!(clean_vk_id_or_domain("durov"), (None, "durov".to_string()));
        assert_eq!(clean_vk_id_or_domain("vk.com/pavel/"), (None, "pavel".to_string()));
    }

    #[test]
    fn test_extract_payload_text_json_and_plain() {
        let json_payload = r#"{"text":"Привет, как дела?","framework":"aida"}"#;
        assert_eq!(extract_payload_text(json_payload), "Привет, как дела?");

        let json_msg = r#"{"message":"Тестовое сообщение"}"#;
        assert_eq!(extract_payload_text(json_msg), "Тестовое сообщение");

        let plain_payload = "Простой текст без json";
        assert_eq!(extract_payload_text(plain_payload), "Простой текст без json");
    }

    #[test]
    fn test_parse_vk_response_success() {
        let json = serde_json::json!({ "response": 42512 });
        let res = parse_vk_api_response(StatusCode::OK, &json);
        assert_eq!(res.unwrap(), "42512");
    }

    #[test]
    fn test_parse_vk_response_captcha_error_14() {
        let json = serde_json::json!({
            "error": {
                "error_code": 14,
                "error_msg": "Captcha needed",
                "request_params": [
                    {"key": "access_token", "value": "SECRET_LEAK_TEST"}
                ]
            }
        });

        let res = parse_vk_api_response(StatusCode::OK, &json);
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert_eq!(err.code, 14);
        assert_eq!(err.message, "Captcha needed");
        // Invariant: Never leak request_params or access_token in Display/String
        let err_str = err.to_string();
        assert!(!err_str.contains("SECRET_LEAK_TEST"));
        assert!(err_str.contains("VK API error 14: Captcha needed"));
    }

    #[test]
    fn test_parse_vk_response_validation_error_17() {
        let json = serde_json::json!({
            "error": {
                "error_code": 17,
                "error_msg": "Validation required"
            }
        });
        let res = parse_vk_api_response(StatusCode::OK, &json);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err().code, 17);
    }

    #[test]
    fn test_parse_vk_response_cant_send_messages_error_901() {
        let json = serde_json::json!({
            "error": {
                "error_code": 901,
                "error_msg": "Can't send messages for users without bi-directional relationship"
            }
        });
        let res = parse_vk_api_response(StatusCode::OK, &json);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err().code, 901);
    }

    #[test]
    fn test_parse_tg_response_success() {
        let json = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 999
            }
        });
        let res = parse_tg_api_response(StatusCode::OK, &json);
        assert_eq!(res.unwrap(), "msg_999");
    }

    #[test]
    fn test_parse_tg_response_error() {
        let json = serde_json::json!({
            "ok": false,
            "description": "Forbidden: bot was blocked by the user"
        });
        let res = parse_tg_api_response(StatusCode::FORBIDDEN, &json);
        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err(),
            "Telegram API error: Forbidden: bot was blocked by the user"
        );
    }
}
