use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::Value as JsonValue;
use std::time::Duration;
use zeroize::Zeroizing;

const REQUEST_TIMEOUT_SECS: u64 = 45;

/// Helper to sanitize error messages so raw API keys are never leaked to logs or UI
pub fn sanitize_error(err_msg: &str, raw_key: &str) -> String {
    if raw_key.is_empty() {
        err_msg.to_string()
    } else {
        err_msg.replace(raw_key, "[REDACTED_API_KEY]")
    }
}

/// Universal Gateway function to execute chat completion requests to OpenAI-compatible or Anthropic APIs
pub async fn send_completion(
    provider: &str,
    base_url: &str,
    raw_key: Zeroizing<String>,
    model_name: &str,
    sys_prompt: &str,
    user_text: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let result = match provider {
        "openai_compat" => {
            send_openai_completion(&client, base_url, &raw_key, model_name, sys_prompt, user_text).await
        }
        "anthropic" => {
            send_anthropic_completion(&client, base_url, &raw_key, model_name, sys_prompt, user_text).await
        }
        unknown => Err(format!(
            "Unsupported provider '{}'. Supported: 'openai_compat', 'anthropic'",
            unknown
        )),
    };

    // Note: raw_key is a Zeroizing<String> wrapper, which automatically zeroes the underlying
    // memory buffer when dropped at function exit.
    match result {
        Ok(text) => Ok(text),
        Err(err) => Err(sanitize_error(&err, &raw_key)),
    }
}

/// OpenAI-compatible completion request
async fn send_openai_completion(
    client: &reqwest::Client,
    base_url: &str,
    raw_key: &str,
    model_name: &str,
    sys_prompt: &str,
    user_text: &str,
) -> Result<String, String> {
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let auth_header_val = format!("Bearer {}", raw_key);
    let mut header_value = HeaderValue::from_str(&auth_header_val)
        .map_err(|_| "Invalid characters in API key header".to_string())?;
    header_value.set_sensitive(true);
    headers.insert(AUTHORIZATION, header_value);

    let body = serde_json::json!({
        "model": model_name,
        "messages": [
            { "role": "system", "content": sys_prompt },
            { "role": "user", "content": user_text }
        ],
        "temperature": 0.7
    });

    let response = client
        .post(&endpoint)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let resp_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if !status.is_success() {
        return Err(extract_provider_error(status.as_u16(), &resp_text));
    }

    let json: JsonValue = serde_json::from_str(&resp_text)
        .map_err(|e| format!("Invalid JSON response: {}", e))?;

    let content = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.trim());

    match content {
        Some(text) if !text.is_empty() => Ok(text.to_string()),
        _ => Err("LLM вернула пустой ответ".to_string()),
    }
}

/// Anthropic Messages completion request
async fn send_anthropic_completion(
    client: &reqwest::Client,
    base_url: &str,
    raw_key: &str,
    model_name: &str,
    sys_prompt: &str,
    user_text: &str,
) -> Result<String, String> {
    let endpoint = format!("{}/messages", base_url.trim_end_matches('/'));

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        reqwest::header::HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static("2023-06-01"),
    );

    let mut api_key_val = HeaderValue::from_str(raw_key)
        .map_err(|_| "Invalid characters in API key header".to_string())?;
    api_key_val.set_sensitive(true);
    headers.insert(
        reqwest::header::HeaderName::from_static("x-api-key"),
        api_key_val,
    );

    let body = serde_json::json!({
        "model": model_name,
        "system": sys_prompt,
        "messages": [
            { "role": "user", "content": user_text }
        ],
        "max_tokens": 2048,
        "temperature": 0.7
    });

    let response = client
        .post(&endpoint)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let resp_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if !status.is_success() {
        return Err(extract_provider_error(status.as_u16(), &resp_text));
    }

    let json: JsonValue = serde_json::from_str(&resp_text)
        .map_err(|e| format!("Invalid JSON response: {}", e))?;

    // Anthropic returns array in content: [{"type": "text", "text": "..."}]
    let mut combined_text = String::new();
    if let Some(content_array) = json.get("content").and_then(|c| c.as_array()) {
        for block in content_array {
            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                combined_text.push_str(text);
            }
        }
    }

    let trimmed = combined_text.trim();
    if trimmed.is_empty() {
        Err("LLM вернула пустой ответ".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

/// Parse provider error JSON to extract human-readable error message
fn extract_provider_error(status_code: u16, body_text: &str) -> String {
    if let Ok(json) = serde_json::from_str::<JsonValue>(body_text) {
        // OpenAI format: {"error": {"message": "..."}} or {"error": "..."}
        if let Some(err_obj) = json.get("error") {
            if let Some(msg) = err_obj.get("message").and_then(|m| m.as_str()) {
                return format!("API Error: {}", msg);
            }
            if let Some(msg) = err_obj.as_str() {
                return format!("API Error: {}", msg);
            }
        }

        // Generic error field
        if let Some(msg) = json.get("message").and_then(|m| m.as_str()) {
            return format!("API Error: {}", msg);
        }
    }

    let snippet = if body_text.len() > 200 {
        format!("{}...", &body_text[..200])
    } else {
        body_text.to_string()
    };

    format!("API Error (status {}): {}", status_code, snippet)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_error_redacts_raw_key() {
        let key = "sk-proj-supersecret123456789";
        let raw_err = format!("Connection failed for Authorization: Bearer {}", key);
        let sanitized = sanitize_error(&raw_err, key);

        assert!(!sanitized.contains(key));
        assert!(sanitized.contains("[REDACTED_API_KEY]"));
    }

    #[test]
    fn test_extract_openai_error_message() {
        let openai_json = r#"{"error":{"message":"Incorrect API key provided: sk-***. You can find your API key at...","type":"invalid_request_error","code":"invalid_api_key"}}"#;
        let err = extract_provider_error(401, openai_json);
        assert_eq!(
            err,
            "API Error: Incorrect API key provided: sk-***. You can find your API key at..."
        );
    }

    #[test]
    fn test_extract_anthropic_error_message() {
        let anthropic_json = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        let err = extract_provider_error(401, anthropic_json);
        assert_eq!(err, "API Error: invalid x-api-key");
    }

    #[test]
    fn test_extract_fallback_error_on_non_json() {
        let plain_err = "502 Bad Gateway from upstream proxy";
        let err = extract_provider_error(502, plain_err);
        assert_eq!(err, "API Error (status 502): 502 Bad Gateway from upstream proxy");
    }
}
