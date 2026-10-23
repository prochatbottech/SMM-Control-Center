//! VK ID OAuth 2.1 (Authorization Code + PKCE) via the external browser.
//!
//! VK ID requires an HTTPS redirect URI (loopback http:// is rejected), so we
//! redirect to the already-trusted `https://oauth.vk.com/blank.html`. The user
//! copies the final address (which contains `?code=...&state=...&device_id=...`)
//! back into the app, and we exchange the code for tokens.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

const VK_ID_APP: &str = "54847796";
const REDIRECT_URI: &str = "https://oauth.vk.com/blank.html";
const SCOPES: &str = "wall,groups,photos";

struct Pending {
    verifier: String,
    device_id: String,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn rand_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(&buf)
}

fn s256(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn hexval(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hexval(bytes[i + 1]), hexval(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_query(q: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            m.insert(urldecode(k), urldecode(v));
        }
    }
    m
}

fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// Start VK ID login: build the authorize URL (PKCE), remember verifier/state,
/// and open it in the system browser. Returns the URL so the UI can also show it.
#[tauri::command]
pub fn vk_oauth_start() -> Result<serde_json::Value, String> {
    let verifier = rand_b64(32);
    let challenge = s256(&verifier);
    let state = rand_b64(16);
    let device_id = rand_b64(16);

    let auth_url = format!(
        "https://id.vk.com/authorize?response_type=code&client_id={app}&redirect_uri={redir}&scope={scope}&state={state}&code_challenge={ch}&code_challenge_method=S256&device_id={dev}",
        app = VK_ID_APP,
        redir = urlencode(REDIRECT_URI),
        scope = SCOPES,
        state = state,
        ch = challenge,
        dev = device_id,
    );

    pending()
        .lock()
        .map_err(|_| "Внутренняя ошибка состояния".to_string())?
        .insert(state.clone(), Pending { verifier, device_id });

    open_browser(&auth_url);

    Ok(serde_json::json!({ "authUrl": auth_url, "state": state }))
}

/// Complete VK ID login: parse `code`/`state`/`device_id` from the pasted
/// redirect URL and exchange the code for an access token (PKCE).
#[tauri::command]
pub async fn vk_oauth_complete(redirect_url: String) -> Result<serde_json::Value, String> {
    let trimmed = redirect_url.trim();
    // Support both "?code=..." and "#code=..." forms; take everything after the first ? or #.
    let query = trimmed
        .split_once('?')
        .map(|(_, q)| q)
        .or_else(|| trimmed.split_once('#').map(|(_, q)| q))
        .unwrap_or(trimmed);
    let params = parse_query(query);

    if let Some(err) = params.get("error") {
        let desc = params.get("error_description").cloned().unwrap_or_default();
        return Err(format!("VK ID: {} {}", err, desc));
    }

    let code = params.get("code").cloned().ok_or_else(|| {
        "В вставленном URL нет параметра code. Скопируйте полный адрес страницы после входа."
            .to_string()
    })?;
    let state = params.get("state").cloned().unwrap_or_default();

    let p = pending()
        .lock()
        .map_err(|_| "Внутренняя ошибка состояния".to_string())?
        .remove(&state)
        .ok_or_else(|| "Сессия входа не найдена/устарела — начните вход заново".to_string())?;

    let device_id = params.get("device_id").cloned().unwrap_or(p.device_id);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Не удалось инициализировать HTTP-клиент".to_string())?;

    let form = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("code_verifier", p.verifier.as_str()),
        ("client_id", VK_ID_APP),
        ("device_id", device_id.as_str()),
        ("redirect_uri", REDIRECT_URI),
    ];
    let resp = client
        .post("https://id.vk.com/oauth2/auth")
        .form(&form)
        .send()
        .await
        .map_err(|_| "Сетевая ошибка при обмене кода VK ID".to_string())?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| format!("Некорректный ответ VK ID (HTTP {})", status.as_u16()))?;

    if let Some(err) = json.get("error") {
        let desc = json.get("error_description").and_then(|v| v.as_str()).unwrap_or("");
        return Err(format!("VK ID token error: {} {}", err, desc));
    }

    let token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("VK ID не вернул access_token: {}", json))?
        .to_string();
    let user_id = json
        .get("user_id")
        .and_then(|v| v.as_i64())
        .map(|n| n.to_string())
        .or_else(|| json.get("user_id").and_then(|v| v.as_str()).map(|s| s.to_string()));

    Ok(serde_json::json!({ "accessToken": token, "userId": user_id }))
}
