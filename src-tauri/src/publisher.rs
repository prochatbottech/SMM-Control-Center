use std::time::Duration;
use reqwest::multipart::{Form, Part};

/// Trait defining the connector interface for publishing posts to social networks
pub trait PostPublisher: Send + Sync {
    fn publish(
        &self,
        platform: &str,
        account_name: &str,
        token: &str,
        content: &str,
        media_urls: &[String],
        format: &str,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
}

/// Real implementation of PostPublisher using reqwest with rustls
#[derive(Clone)]
pub struct RealPublisher {
    client: reqwest::Client,
    tg_base_url: Option<String>,
    vk_base_url: Option<String>,
}

impl RealPublisher {
    /// Create a new RealPublisher with official production endpoints
    /// Invariant: 10-second timeout strictly configured on reqwest::Client
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to initialize reqwest Client with rustls");

        Self {
            client,
            tg_base_url: None,
            vk_base_url: None,
        }
    }

    /// Create RealPublisher with custom base URLs for testing and sandboxed environments
    pub fn with_endpoints(
        tg_base_url: Option<String>,
        vk_base_url: Option<String>,
    ) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("Failed to initialize reqwest Client with rustls");

        Self {
            client,
            tg_base_url,
            vk_base_url,
        }
    }

    /// Parse Telegram JSON API response
    pub(crate) fn parse_telegram_response(
        status: reqwest::StatusCode,
        body_json: &serde_json::Value,
    ) -> Result<String, String> {
        // Extract error description if ok == false
        if let Some(ok) = body_json.get("ok").and_then(|v| v.as_bool()) {
            if !ok {
                let desc = body_json
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown Telegram error");
                return Err(format!("Telegram API error: {}", desc));
            }
        } else if !status.is_success() {
            return Err(format!("Telegram API returned HTTP status {}", status.as_u16()));
        }

        // Extract message_id on success
        if let Some(message_id) = body_json
            .get("result")
            .and_then(|r| r.get("message_id"))
            .and_then(|m| m.as_i64())
        {
            Ok(format!("tg_{}", message_id))
        } else {
            Ok(format!("tg_published_{}", uuid::Uuid::new_v4()))
        }
    }

    /// Parse VKontakte JSON API response
    pub(crate) fn parse_vk_response(
        status: reqwest::StatusCode,
        body_json: &serde_json::Value,
    ) -> Result<String, String> {
        // Invariant: Check for logical "error" field in VK JSON response
        // VK returns HTTP 200 with {"error": {"error_code": 14, "error_msg": "Captcha needed", "request_params": [...]}}
        // CRITICAL INVARIANT: NEVER format or log error_obj or request_params as it leaks access_token!
        // Only extract error_code and error_msg.
        if let Some(error_obj) = body_json.get("error") {
            let code = error_obj
                .get("error_code")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let msg = error_obj
                .get("error_msg")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown VK error");
            return Err(format!("VK API error {}: {}", code, msg));
        }

        if !status.is_success() {
            return Err(format!("VK API returned HTTP status {}", status.as_u16()));
        }

        // Extract post_id on success
        if let Some(post_id) = body_json
            .get("response")
            .and_then(|r| r.get("post_id"))
            .and_then(|p| p.as_i64())
        {
            Ok(format!("vk_{}", post_id))
        } else {
            Ok(format!("vk_published_{}", uuid::Uuid::new_v4()))
        }
    }

    /// Internal Telegram publishing logic (text only or with photos)
    async fn publish_telegram(
        &self,
        account_name: &str,
        token: &str,
        content: &str,
        media_urls: &[String],
    ) -> Result<String, String> {
        let base_url = self
            .tg_base_url
            .as_deref()
            .unwrap_or("https://api.telegram.org");
        let chat_id = normalize_telegram_chat_id(account_name);

        if media_urls.is_empty() {
            let url = format!("{}/bot{}/sendMessage", base_url, token);
            let payload = serde_json::json!({
                "chat_id": chat_id,
                "text": content,
            });

            // Invariant: Masking network errors (URL Redaction)
            let resp = match self.client.post(&url).json(&payload).send().await {
                Ok(r) => r,
                Err(_) => {
                    return Err("Network or API error occurred".to_string());
                }
            };

            let status = resp.status();
            let body_json: serde_json::Value = match resp.json().await {
                Ok(j) => j,
                Err(_) => {
                    if !status.is_success() {
                        return Err(format!("Telegram API returned HTTP status {}", status.as_u16()));
                    }
                    return Err("Network or API error occurred".to_string());
                }
            };

            return Self::parse_telegram_response(status, &body_json);
        }

        if media_urls.len() == 1 {
            self.publish_telegram_single_photo(base_url, token, &chat_id, content, &media_urls[0])
                .await
        } else {
            self.publish_telegram_media_group(base_url, token, &chat_id, content, media_urls)
                .await
        }
    }

    /// Publish a rich (article-style) message to Telegram via `sendRichMessage` (Bot API 10.1+).
    /// The content is sent as Markdown and rendered as a rich structured message.
    async fn publish_telegram_rich(
        &self,
        token: &str,
        account_name: &str,
        content: &str,
    ) -> Result<String, String> {
        let base_url = self
            .tg_base_url
            .as_deref()
            .unwrap_or("https://api.telegram.org");
        let url = format!("{}/bot{}/sendRichMessage", base_url, token);
        let chat_id = normalize_telegram_chat_id(account_name);

        let payload = serde_json::json!({
            "chat_id": chat_id,
            "rich_message": { "markdown": content },
        });

        let resp = match self.client.post(&url).json(&payload).send().await {
            Ok(r) => r,
            Err(_) => return Err("Network or API error occurred".to_string()),
        };

        let status = resp.status();
        let body_json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(_) => {
                if !status.is_success() {
                    return Err(format!("Telegram API returned HTTP status {}", status.as_u16()));
                }
                return Err("Network or API error occurred".to_string());
            }
        };

        Self::parse_telegram_response(status, &body_json)
    }

    async fn publish_telegram_single_photo(
        &self,
        base_url: &str,
        token: &str,
        chat_id: &str,
        content: &str,
        media_path: &str,
    ) -> Result<String, String> {
        let url = format!("{}/bot{}/sendPhoto", base_url, token);
        let bytes = read_media_bytes(media_path).await?;
        let file_name = media_file_name(media_path);
        let mime = mime_for_path(media_path);

        let form = Form::new()
            .text("chat_id", chat_id.to_string())
            .text("caption", content.to_string())
            .part(
                "photo",
                Part::bytes(bytes)
                    .file_name(file_name)
                    .mime_str(mime)
                    .map_err(|_| "Не удалось сформировать медиавложение".to_string())?,
            );

        let resp = match self.client.post(&url).multipart(form).send().await {
            Ok(r) => r,
            Err(_) => return Err("Network or API error occurred".to_string()),
        };

        let status = resp.status();
        let body_json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(_) => {
                if !status.is_success() {
                    return Err(format!("Telegram API returned HTTP status {}", status.as_u16()));
                }
                return Err("Network or API error occurred".to_string());
            }
        };

        Self::parse_telegram_response(status, &body_json)
    }

    async fn publish_telegram_media_group(
        &self,
        base_url: &str,
        token: &str,
        chat_id: &str,
        content: &str,
        media_urls: &[String],
    ) -> Result<String, String> {
        let url = format!("{}/bot{}/sendMediaGroup", base_url, token);

        let mut media_json: Vec<serde_json::Value> = Vec::with_capacity(media_urls.len());
        let mut form = Form::new().text("chat_id", chat_id.to_string());

        for (i, path) in media_urls.iter().enumerate() {
            let bytes = read_media_bytes(path).await?;
            let file_name = media_file_name(path);
            let mime = mime_for_path(path);
            let attach_name = format!("file{}", i);

            let mut item = serde_json::json!({
                "type": "photo",
                "media": format!("attach://{}", attach_name),
            });
            if i == 0 && !content.is_empty() {
                item["caption"] = serde_json::Value::String(content.to_string());
            }
            media_json.push(item);

            form = form.part(
                attach_name,
                Part::bytes(bytes)
                    .file_name(file_name)
                    .mime_str(mime)
                    .map_err(|_| "Не удалось сформировать медиавложение".to_string())?,
            );
        }

        form = form.text("media", serde_json::to_string(&media_json).unwrap_or_default());

        let resp = match self.client.post(&url).multipart(form).send().await {
            Ok(r) => r,
            Err(_) => return Err("Network or API error occurred".to_string()),
        };

        let status = resp.status();
        let body_json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(_) => {
                if !status.is_success() {
                    return Err(format!("Telegram API returned HTTP status {}", status.as_u16()));
                }
                return Err("Network or API error occurred".to_string());
            }
        };

        Self::parse_telegram_response(status, &body_json)
    }

    /// Detect a VK community id for a community (group) access token.
    /// `groups.getById` without `group_ids` returns the community that owns the token.
    /// Returns None for user tokens (or if detection fails), meaning "post as the user".
    async fn resolve_vk_group_id(&self, base_url: &str, token: &str) -> Option<i64> {
        let url = format!("{}/method/groups.getById", base_url);
        let params = [("access_token", token), ("v", "5.199")];
        let resp = self.client.post(&url).form(&params).send().await.ok()?;
        let json: serde_json::Value = resp.json().await.ok()?;
        let response = json.get("response")?;

        if let Some(arr) = response.as_array() {
            return arr.first().and_then(|g| g.get("id")).and_then(|v| v.as_i64());
        }
        for key in ["groups", "items"] {
            if let Some(arr) = response.get(key).and_then(|v| v.as_array()) {
                if let Some(id) = arr.first().and_then(|g| g.get("id")).and_then(|v| v.as_i64()) {
                    return Some(id);
                }
            }
        }
        response.get("id").and_then(|v| v.as_i64())
    }

    /// Internal VKontakte publishing logic (text only or with photos)
    async fn publish_vk(
        &self,
        token: &str,
        content: &str,
        media_urls: &[String],
    ) -> Result<String, String> {
        let base_url = self
            .vk_base_url
            .as_deref()
            .unwrap_or("https://api.vk.com");

        // Detect community (group) token. Community tokens must post with
        // owner_id = -<group_id> and from_group = 1, otherwise VK returns
        // error 27 "method is unavailable with group auth".
        let group_id = self.resolve_vk_group_id(base_url, token).await;
        let owner_id_neg = group_id.map(|g| format!("-{}", g));

        let mut attachments: Vec<String> = Vec::new();
        for path in media_urls {
            let attachment = self.upload_vk_photo(base_url, token, path, group_id).await?;
            attachments.push(attachment);
        }

        let url = format!("{}/method/wall.post", base_url);
        let mut params: Vec<(&str, &str)> = vec![
            ("access_token", token),
            ("v", "5.199"),
            ("message", content),
        ];

        if let Some(ref owner_id) = owner_id_neg {
            params.push(("owner_id", owner_id.as_str()));
            params.push(("from_group", "1"));
        }

        let attachments_joined = attachments.join(",");
        if !attachments_joined.is_empty() {
            params.push(("attachments", &attachments_joined));
        }

        // Invariant: POST form-urlencoded keeps token in body, not in URL query string
        // Invariant: Masking network errors without logging raw reqwest::Error
        let resp = match self.client.post(&url).form(&params).send().await {
            Ok(r) => r,
            Err(_) => {
                return Err("Network or API error occurred".to_string());
            }
        };

        let status = resp.status();
        let body_json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(_) => {
                if !status.is_success() {
                    return Err(format!("VK API returned HTTP status {}", status.as_u16()));
                }
                return Err("Network or API error occurred".to_string());
            }
        };

        Self::parse_vk_response(status, &body_json)
    }

    /// Upload a single local photo to VK and return the `photo{owner_id}_{id}` attachment string.
    async fn upload_vk_photo(
        &self,
        base_url: &str,
        token: &str,
        path: &str,
        group_id: Option<i64>,
    ) -> Result<String, String> {
        let bytes = read_media_bytes(path).await?;
        let file_name = media_file_name(path);
        let mime = mime_for_path(path);
        let gid_str = group_id.map(|g| g.to_string());

        // 1. Obtain an upload URL for a wall photo
        let upload_server_url = format!("{}/method/photos.getWallUploadServer", base_url);
        let mut params: Vec<(&str, &str)> = vec![("access_token", token), ("v", "5.199")];
        if let Some(ref gid) = gid_str {
            params.push(("group_id", gid.as_str()));
        }
        let resp = match self.client.post(&upload_server_url).form(&params).send().await {
            Ok(r) => r,
            Err(_) => return Err("Network or API error occurred".to_string()),
        };
        let status = resp.status();
        let body_json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(_) => {
                if !status.is_success() {
                    return Err(format!("VK API returned HTTP status {}", status.as_u16()));
                }
                return Err("Network or API error occurred".to_string());
            }
        };

        // Reuse logical error parsing, then extract upload_url
        Self::parse_vk_response(status, &body_json)?;
        let upload_url = body_json
            .get("response")
            .and_then(|r| r.get("upload_url"))
            .and_then(|u| u.as_str())
            .ok_or_else(|| "VK API: отсутствует upload_url для загрузки фото".to_string())?
            .to_string();

        // 2. Upload the photo bytes to VK upload server
        let form = Form::new().part(
            "photo",
            Part::bytes(bytes)
                .file_name(file_name)
                .mime_str(mime)
                .map_err(|_| "Не удалось сформировать медиавложение".to_string())?,
        );
        let upload_resp = match self.client.post(&upload_url).multipart(form).send().await {
            Ok(r) => r,
            Err(_) => return Err("Network or API error occurred".to_string()),
        };
        let upload_status = upload_resp.status();
        let upload_json: serde_json::Value = match upload_resp.json().await {
            Ok(j) => j,
            Err(_) => {
                if !upload_status.is_success() {
                    return Err(format!("VK upload returned HTTP status {}", upload_status.as_u16()));
                }
                return Err("Network or API error occurred".to_string());
            }
        };

        let server = upload_json
            .get("server")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "VK upload: отсутствует server".to_string())?
            .to_string();
        let photo = upload_json
            .get("photo")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "VK upload: отсутствует photo".to_string())?
            .to_string();
        let hash = upload_json
            .get("hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "VK upload: отсутствует hash".to_string())?
            .to_string();

        // 3. Save the uploaded photo to the wall album
        let save_url = format!("{}/method/photos.saveWallPhoto", base_url);
        let mut save_params: Vec<(&str, &str)> = vec![
            ("access_token", token),
            ("v", "5.199"),
            ("server", &server),
            ("photo", &photo),
            ("hash", &hash),
        ];
        if let Some(ref gid) = gid_str {
            save_params.push(("group_id", gid.as_str()));
        }
        let save_resp = match self.client.post(&save_url).form(&save_params).send().await {
            Ok(r) => r,
            Err(_) => return Err("Network or API error occurred".to_string()),
        };
        let save_status = save_resp.status();
        let save_json: serde_json::Value = match save_resp.json().await {
            Ok(j) => j,
            Err(_) => {
                if !save_status.is_success() {
                    return Err(format!("VK API returned HTTP status {}", save_status.as_u16()));
                }
                return Err("Network or API error occurred".to_string());
            }
        };
        Self::parse_vk_response(save_status, &save_json)?;

        let owner_id = save_json
            .get("response")
            .and_then(|r| r.get(0))
            .and_then(|p| p.get("owner_id"))
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "VK saveWallPhoto: отсутствует owner_id".to_string())?;
        let photo_id = save_json
            .get("response")
            .and_then(|r| r.get(0))
            .and_then(|p| p.get("id"))
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "VK saveWallPhoto: отсутствует id".to_string())?;

        Ok(format!("photo{}_{}", owner_id, photo_id))
    }

    /// Publish a text post to an OK (Одноклассники) group wall via `mediatopic.post`.
    /// The token field is expected to be a JSON string with OK credentials.
    async fn publish_ok(
        &self,
        token: &str,
        content: &str,
        _media_urls: &[String],
    ) -> Result<String, String> {
        let creds: OkCredentials = serde_json::from_str(token).map_err(|_| {
            "OK: неверный формат учётных данных (ожидается JSON с access_token, application_key, session_secret_key, gid)".to_string()
        })?;

        let base_url = "https://api.ok.ru";
        let url = format!("{}/api/mediatopic.post", base_url);

        let attachment = serde_json::json!({
            "media": [{ "type": "text", "text": content }]
        })
        .to_string();

        let mut params: Vec<(String, String)> = vec![
            ("application_key".to_string(), creds.application_key.clone()),
            ("method".to_string(), "mediatopic.post".to_string()),
            ("format".to_string(), "json".to_string()),
            ("access_token".to_string(), creds.access_token.clone()),
            ("type".to_string(), "GROUP_THEME".to_string()),
            ("attachment".to_string(), attachment),
        ];
        if let Some(gid) = &creds.gid {
            if !gid.is_empty() {
                params.push(("gid".to_string(), gid.clone()));
            }
        }

        let sig = compute_ok_signature(&params, &creds.session_secret_key);
        params.push(("sig".to_string(), sig));

        // Invariant: POST form-urlencoded keeps token in body, not in URL query string
        let resp = match self.client.post(&url).form(&params).send().await {
            Ok(r) => r,
            Err(_) => return Err("Network or API error occurred".to_string()),
        };

        let status = resp.status();
        let body_json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(_) => {
                if !status.is_success() {
                    return Err(format!("OK API returned HTTP status {}", status.as_u16()));
                }
                return Err("Network or API error occurred".to_string());
            }
        };

        // Invariant: Extract only human-readable error fields, never echo token params
        if let Some(err_code) = body_json
            .get("error_code")
            .or_else(|| body_json.get("error"))
            .and_then(|v| {
                v.as_i64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_str().map(|s| s.to_string()))
            })
        {
            let msg = body_json
                .get("error_msg")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown OK error");
            return Err(format!("OK API error {}: {}", err_code, msg));
        }

        if let Some(topic_id) = body_json.get("id").and_then(|v| v.as_str()) {
            Ok(format!("ok_{}", topic_id))
        } else if !status.is_success() {
            Err(format!("OK API returned HTTP status {}", status.as_u16()))
        } else {
            Ok(format!("ok_published_{}", uuid::Uuid::new_v4()))
        }
    }
}

/// Normalize Telegram chat_id / channel username.
/// Invariant: Telegram Bot API requires channel/supergroup usernames to start with '@'.
/// If the user inputs "NetGeniusAI" or "https://t.me/NetGeniusAI", normalize to "@NetGeniusAI".
/// Numeric IDs (e.g. -1001234567890 or 123456789) are preserved as-is.
pub fn normalize_telegram_chat_id(raw: &str) -> String {
    let mut cleaned = raw.trim();

    // Strip URL prefixes if provided
    for prefix in &[
        "https://t.me/",
        "http://t.me/",
        "t.me/",
        "https://telegram.me/",
        "http://telegram.me/",
        "telegram.me/",
    ] {
        if let Some(stripped) = cleaned.strip_prefix(prefix) {
            cleaned = stripped;
            break;
        }
    }

    // Strip trailing slashes or path segments (e.g. "NetGeniusAI/" -> "NetGeniusAI")
    cleaned = cleaned.trim_matches('/');

    // If it's already a numeric ID (e.g. -1001234567890 or 123456789), keep as is
    if cleaned.parse::<i64>().is_ok() {
        return cleaned.to_string();
    }

    // If it already starts with '@', return it
    if cleaned.starts_with('@') {
        return cleaned.to_string();
    }

    // Otherwise, prepend '@' for public channel/group usernames
    format!("@{}", cleaned)
}

/// Extract a file name (with extension) from a local path, handling both separators.
fn media_file_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("photo.jpg")
        .to_string()
}

/// Infer a MIME type from a local file path by extension.
fn mime_for_path(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    }
}

/// Read a local media file into memory for upload.
/// Invariant: Errors must not leak the absolute path or raw IO error text.
async fn read_media_bytes(path: &str) -> Result<Vec<u8>, String> {
    tokio::fs::read(path)
        .await
        .map_err(|_| "Не удалось прочитать локальный медиафайл".to_string())
}

/// Credentials required to publish to OK (Одноклассники) via the REST API.
/// Stored as a JSON string inside the account's encrypted token field.
#[derive(serde::Deserialize)]
struct OkCredentials {
    access_token: String,
    application_key: String,
    session_secret_key: String,
    #[serde(default)]
    gid: Option<String>,
}

/// Compute the OK REST API signature: MD5 of sorted `key=value` pairs concatenated
/// with the session secret key.
pub fn compute_ok_signature(params: &[(String, String)], secret_key: &str) -> String {
    let mut sorted = params.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut base = String::new();
    for (k, v) in &sorted {
        base.push_str(k);
        base.push('=');
        base.push_str(v);
    }
    base.push_str(secret_key);
    format!("{:x}", md5::compute(base.as_bytes()))
}

impl Default for RealPublisher {
    fn default() -> Self {
        Self::new()
    }
}

impl PostPublisher for RealPublisher {
    async fn publish(
        &self,
        platform: &str,
        account_name: &str,
        token: &str,
        content: &str,
        media_urls: &[String],
        format: &str,
    ) -> Result<String, String> {
        let platform_norm = platform.trim().to_lowercase();
        let is_article = format.trim().eq_ignore_ascii_case("article");
        // Telegram regular messages are limited to 4096 UTF-16 units. Long text-only
        // posts automatically fall back to a rich (article) message to avoid rejection.
        let too_long_for_post = content.encode_utf16().count() > 4096;
        match platform_norm.as_str() {
            "vk" => self.publish_vk(token, content, media_urls).await,
            "tg" | "telegram" => {
                if is_article || (too_long_for_post && media_urls.is_empty()) {
                    self.publish_telegram_rich(token, account_name, content).await
                } else {
                    self.publish_telegram(account_name, token, content, media_urls).await
                }
            }
            "ok" => self.publish_ok(token, content, media_urls).await,
            _ => Err("Unsupported platform".to_string()),
        }
    }
}

/// Mock implementation of the post publisher simulating network requests
pub struct MockPublisher {
    pub simulated_delay_ms: u64,
    pub should_fail: bool,
}

impl MockPublisher {
    pub fn new() -> Self {
        Self {
            simulated_delay_ms: 1000,
            should_fail: false,
        }
    }

    pub fn with_delay(delay_ms: u64) -> Self {
        Self {
            simulated_delay_ms: delay_ms,
            should_fail: false,
        }
    }

    pub fn failing() -> Self {
        Self {
            simulated_delay_ms: 50,
            should_fail: true,
        }
    }
}

impl Default for MockPublisher {
    fn default() -> Self {
        Self::new()
    }
}

impl PostPublisher for MockPublisher {
    async fn publish(
        &self,
        platform: &str,
        account_name: &str,
        _token: &str, // Invariant: Raw token is never logged or leaked
        content: &str,
        media_urls: &[String],
        _format: &str,
    ) -> Result<String, String> {
        println!(
            "[MockPublisher] Starting network request to '{}' for account '{}' (content_len: {}, media_count: {})",
            platform,
            account_name,
            content.len(),
            media_urls.len()
        );

        if self.simulated_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(self.simulated_delay_ms)).await;
        }

        if self.should_fail {
            let err_msg = format!("Simulated network timeout/API error for '{}'", platform);
            eprintln!("[MockPublisher] Error: {}", err_msg);
            return Err(err_msg);
        }

        let post_id = format!("mock_{}_{}", platform, uuid::Uuid::new_v4());
        println!(
            "[MockPublisher] Successfully published post to '{}' ({}) -> external_id: {}",
            account_name, platform, post_id
        );

        Ok(post_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_unsupported_platform() {
        let publisher = RealPublisher::new();
        let res = publisher
            .publish("instagram", "insta_user", "tok123", "Hello IG", &[], "post")
            .await;
        assert_eq!(res, Err("Unsupported platform".to_string()));

        let res_twitter = publisher
            .publish("twitter", "x_user", "tok456", "Hello X", &[], "post")
            .await;
        assert_eq!(res_twitter, Err("Unsupported platform".to_string()));
    }

    #[tokio::test]
    async fn test_network_error_masking_redacts_token() {
        // Point to an invalid unreachable port
        let unreachable_url = "http://127.0.0.1:1".to_string();
        let publisher = RealPublisher::with_endpoints(
            Some(unreachable_url.clone()),
            Some(unreachable_url),
        );

        let secret_token = "SUPER_SECRET_TOKEN_DO_NOT_LEAK";

        // TG network error
        let tg_res = publisher
            .publish("tg", "@test_chat", secret_token, "Test message", &[], "post")
            .await;
        assert!(tg_res.is_err());
        let tg_err = tg_res.unwrap_err();
        assert_eq!(tg_err, "Network or API error occurred");
        assert!(
            !tg_err.contains(secret_token),
            "Error must not leak secret token"
        );

        // VK network error
        let vk_res = publisher
            .publish("vk", "VK User", secret_token, "Test message", &[], "post")
            .await;
        assert!(vk_res.is_err());
        let vk_err = vk_res.unwrap_err();
        assert_eq!(vk_err, "Network or API error occurred");
        assert!(
            !vk_err.contains(secret_token),
            "Error must not leak secret token"
        );
    }

    #[test]
    fn test_telegram_response_success() {
        let body: serde_json::Value = serde_json::json!({
            "ok": true,
            "result": {
                "message_id": 777
            }
        });

        let res = RealPublisher::parse_telegram_response(reqwest::StatusCode::OK, &body);
        assert_eq!(res, Ok("tg_777".to_string()));
    }

    #[test]
    fn test_telegram_response_api_error_redaction() {
        let body: serde_json::Value = serde_json::json!({
            "ok": false,
            "error_code": 400,
            "description": "Bad Request: chat not found"
        });

        let res = RealPublisher::parse_telegram_response(reqwest::StatusCode::BAD_REQUEST, &body);
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert_eq!(err, "Telegram API error: Bad Request: chat not found");
    }

    #[test]
    fn test_vk_response_success() {
        let body: serde_json::Value = serde_json::json!({
            "response": {
                "post_id": 9999
            }
        });

        let res = RealPublisher::parse_vk_response(reqwest::StatusCode::OK, &body);
        assert_eq!(res, Ok("vk_9999".to_string()));
    }

    #[test]
    fn test_vk_response_api_error_redaction() {
        // VK returns HTTP 200 with error and request_params containing access_token
        let secret_token = "vk1.a.CRITICAL_SECRET_TOKEN_LEAK";
        let body: serde_json::Value = serde_json::json!({
            "error": {
                "error_code": 14,
                "error_msg": "Captcha needed",
                "request_params": [
                    {"key": "access_token", "value": secret_token},
                    {"key": "v", "value": "5.199"},
                    {"key": "message", "value": "Hello"}
                ]
            }
        });

        let res = RealPublisher::parse_vk_response(reqwest::StatusCode::OK, &body);
        assert!(res.is_err());
        let err = res.unwrap_err();

        // Must extract ONLY human-readable error reason
        assert_eq!(err, "VK API error 14: Captcha needed");
        // CRITICAL INVARIANT: Token must NOT be in error output
        assert!(
            !err.contains(secret_token),
            "VK error must NEVER leak access_token from request_params"
        );
        assert!(
            !err.contains("request_params"),
            "VK error must not dump request_params"
        );
    }

    #[test]
    fn test_normalize_telegram_chat_id() {
        assert_eq!(normalize_telegram_chat_id("NetGeniusAI"), "@NetGeniusAI");
        assert_eq!(normalize_telegram_chat_id("@NetGeniusAI"), "@NetGeniusAI");
        assert_eq!(normalize_telegram_chat_id("https://t.me/NetGeniusAI"), "@NetGeniusAI");
        assert_eq!(normalize_telegram_chat_id("http://t.me/NetGeniusAI/"), "@NetGeniusAI");
        assert_eq!(normalize_telegram_chat_id("t.me/NetGeniusAI"), "@NetGeniusAI");
        assert_eq!(normalize_telegram_chat_id("-1001234567890"), "-1001234567890");
        assert_eq!(normalize_telegram_chat_id("12345678"), "12345678");
        assert_eq!(normalize_telegram_chat_id("  NetGeniusAI  "), "@NetGeniusAI");
    }

    #[test]
    fn test_media_file_name_and_mime() {
        assert_eq!(media_file_name(r"C:\photos\banner.png"), "banner.png");
        assert_eq!(media_file_name("/home/user/img.webp"), "img.webp");
        assert_eq!(mime_for_path("photo.png"), "image/png");
        assert_eq!(mime_for_path("photo.webp"), "image/webp");
        assert_eq!(mime_for_path("photo.jpg"), "image/jpeg");
        assert_eq!(mime_for_path("photo.jpeg"), "image/jpeg");
    }

    #[tokio::test]
    async fn test_missing_media_file_returns_clean_error() {
        let publisher = RealPublisher::new();
        let secret_token = "SUPER_SECRET_TOKEN_DO_NOT_LEAK";
        let missing_path = r"C:\definitely\not\existing\photo.jpg";

        let vk_res = publisher
            .publish("vk", "VK User", secret_token, "Hello", &[missing_path.to_string()], "post")
            .await;
        assert!(vk_res.is_err());
        let err = vk_res.unwrap_err();
        assert_eq!(err, "Не удалось прочитать локальный медиафайл");
        assert!(!err.contains(missing_path), "Error must not leak the local path");
        assert!(!err.contains(secret_token), "Error must not leak the token");
    }

    #[test]
    fn test_compute_ok_signature_deterministic_and_order_independent() {
        let a = vec![
            ("b".to_string(), "2".to_string()),
            ("a".to_string(), "1".to_string()),
        ];
        let b = vec![
            ("a".to_string(), "1".to_string()),
            ("b".to_string(), "2".to_string()),
        ];

        let s1 = compute_ok_signature(&a, "secret");
        let s2 = compute_ok_signature(&b, "secret");
        assert_eq!(s1, s2, "Signature must not depend on param order");
        assert_eq!(s1.len(), 32, "MD5 hex digest must be 32 chars");
        assert!(s1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn test_publish_ok_invalid_credentials_returns_clean_error() {
        let publisher = RealPublisher::new();
        // Not valid JSON creds
        let res = publisher.publish("ok", "OK Group", "not-a-json", "Hello", &[], "post").await;
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("неверный формат учётных данных"));
        assert!(!err.contains("not-a-json"));
    }
}
