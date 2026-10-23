//! VK ID OAuth 2.1 (Authorization Code + PKCE) via external browser and a
//! local loopback server. Used instead of the in-app VK ID JS SDK, because the
//! Tauri webview cannot open the SDK's popup ("Cannot create new tab").

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

const VK_ID_APP: &str = "54847796";
const REDIRECT_URI: &str = "http://127.0.0.1:53682/vk/callback";
const CALLBACK_PORT: u16 = 53682;
const SCOPES: &str = "wall,groups,photos";
const TIMEOUT: Duration = Duration::from_secs(180);

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

fn parse_query(q: &str) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
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

/// Full VK ID login: opens browser, waits for loopback callback, exchanges code.
/// Returns (access_token, user_id).
pub async fn login() -> Result<(String, Option<String>), String> {
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

    let listener = std::net::TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
        .map_err(|e| format!("Не удалось занять порт {}: {}", CALLBACK_PORT, e))?;
    let _ = listener.set_nonblocking(true);

    open_browser(&auth_url);

    let expected_state = state.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            if start.elapsed() > TIMEOUT {
                let _ = tx.send(Err("Время ожидания входа истекло (3 минуты)".to_string()));
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let first = req.lines().next().unwrap_or("");
                    let path = first.split_whitespace().nth(1).unwrap_or("");
                    if path.starts_with("/vk/callback") {
                        let query = path.splitn(2, '?').nth(1).unwrap_or("");
                        let params = parse_query(query);
                        let body = "<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:sans-serif;padding:2rem\"><h3>Вход выполнен. Можете закрыть окно и вернуться в приложение.</h3></body>";
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.flush();

                        let got_state = params.get("state").cloned().unwrap_or_default();
                        if got_state != expected_state {
                            let _ = tx.send(Err("state не совпал (возможна CSRF-атака)".to_string()));
                        } else if let Some(code) = params.get("code") {
                            let _ = tx.send(Ok(code.clone()));
                        } else if let Some(err) = params.get("error") {
                            let desc = params.get("error_description").cloned().unwrap_or_default();
                            let _ = tx.send(Err(format!("VK: {} {}", err, desc)));
                        } else {
                            let _ = tx.send(Err("VK не вернул code".to_string()));
                        }
                        break;
                    } else {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = stream.flush();
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_millis(150)),
            }
        }
    });

    let code = tokio::task::spawn_blocking(move || rx.recv())
        .await
        .map_err(|_| "Ожидание callback прервано".to_string())?
        .map_err(|_| "Ожидание callback прервано".to_string())??;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Не удалось инициализировать HTTP-клиент".to_string())?;

    let params = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("client_id", VK_ID_APP),
        ("device_id", device_id.as_str()),
        ("redirect_uri", REDIRECT_URI),
    ];
    let resp = client
        .post("https://id.vk.com/oauth2/auth")
        .form(&params)
        .send()
        .await
        .map_err(|_| "Сетевая ошибка при обмене кода VK ID".to_string())?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| format!("Некорректный ответ VK ID (HTTP {})", status.as_u16()))?;

    if let Some(err) = json.get("error") {
        let desc = json
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
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

    Ok((token, user_id))
}

/// Tauri Command: perform VK ID login (browser + loopback) and return token + user id.
#[tauri::command]
pub async fn vk_oauth_login() -> Result<serde_json::Value, String> {
    let (token, user_id) = login().await?;
    Ok(serde_json::json!({ "accessToken": token, "userId": user_id }))
}
