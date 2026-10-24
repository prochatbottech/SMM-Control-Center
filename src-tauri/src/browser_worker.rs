//! Runs the Playwright browser-automation worker (Node) as a short-lived child
//! process per request. This keeps `automation/worker.mjs` changes effective
//! without restarting the app and avoids a stuck long-lived worker.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

static PROFILES_DIR: OnceLock<String> = OnceLock::new();
static LOGIN_STATUS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();

/// Locate `automation/worker.mjs`: env override, cwd upward, exe upward.
fn worker_script() -> String {
    if let Ok(p) = std::env::var("BROWSER_WORKER_SCRIPT") {
        if !p.is_empty() {
            return p;
        }
    }

    let rel = PathBuf::from("automation").join("worker.mjs");

    if let Ok(cwd) = std::env::current_dir() {
        let mut dir: Option<&std::path::Path> = Some(cwd.as_path());
        while let Some(d) = dir {
            let cand = d.join(&rel);
            if cand.exists() {
                return cand.to_string_lossy().to_string();
            }
            dir = d.parent();
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent();
        while let Some(d) = dir {
            let cand = d.join(&rel);
            if cand.exists() {
                return cand.to_string_lossy().to_string();
            }
            dir = d.parent();
        }
    }

    rel.to_string_lossy().to_string()
}

/// Spawn the worker for a single request, feed it one JSON line, and return the
/// matching response. The process exits after processing (stdin closed).
fn run_worker(req: Value, timeout: Duration) -> Result<Value, String> {
    let script = worker_script();
    let profiles = PROFILES_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| "browser_profiles".to_string());

    let mut child = Command::new("node")
        .arg(&script)
        .env("BROWSER_PROFILES_DIR", &profiles)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn node ({}): {}", script, e))?;

    let req_id: u64 = 1;
    let mut req = req;
    req["id"] = json!(req_id);

    {
        let mut stdin = child.stdin.take().ok_or("worker has no stdin")?;
        stdin
            .write_all((serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n").as_bytes())
            .map_err(|e| format!("worker write error: {}", e))?;
        let _ = stdin.flush();
    } // drop stdin -> EOF after the single request line

    let stdout = child.stdout.take().ok_or("worker has no stdout")?;
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("id").and_then(|x| x.as_u64()) == Some(req_id) {
                let _ = tx.send(v);
                return;
            }
        }
        let _ = tx.send(json!({ "id": req_id, "ok": false, "error": "worker closed without response" }));
    });

    let result = rx
        .recv_timeout(timeout)
        .map_err(|_| format!("Browser worker timeout ({}s)", timeout.as_secs()));

    let _ = child.wait();
    result
}

/// Resolve and cache the persistent profile directory at app startup so that
/// scheduled posts work after a restart without a prior manual login call.
pub fn init(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        PROFILES_DIR.get_or_init(|| {
            dir.join("browser_profiles")
                .to_string_lossy()
                .to_string()
        });
    }
}

fn set_login_status(account_id: &str, status: Value) {
    if let Some(map) = LOGIN_STATUS.get() {
        map.lock().unwrap().insert(account_id.to_string(), status);
    }
}

/// Start a manual (headed) login. Returns immediately; poll `browser_login_status`.
#[tauri::command]
pub fn browser_login_start(
    app: tauri::AppHandle,
    account_id: String,
    platform: String,
) -> Result<Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser_profiles")
        .to_string_lossy()
        .to_string();
    PROFILES_DIR.get_or_init(|| dir);

    let status = LOGIN_STATUS.get_or_init(|| Mutex::new(HashMap::new()));
    status
        .lock()
        .unwrap()
        .insert(account_id.clone(), json!({ "status": "pending" }));

    let account_id_for_thread = account_id.clone();
    std::thread::spawn(move || {
        let req = json!({ "cmd": "login", "accountId": account_id_for_thread, "platform": platform });
        let result = match run_worker(req, Duration::from_secs(360)) {
            Ok(v) if v.get("ok").and_then(|x| x.as_bool()) == Some(true) => {
                json!({ "status": "success" })
            }
            Ok(v) => json!({ "status": "error", "error": v.get("error").cloned() }),
            Err(e) => json!({ "status": "error", "error": e }),
        };
        set_login_status(&account_id_for_thread, result);
    });

    Ok(json!({ "accountId": account_id }))
}

#[tauri::command]
pub fn browser_login_status(account_id: String) -> Result<Value, String> {
    let status = LOGIN_STATUS
        .get()
        .and_then(|m| m.lock().unwrap().get(&account_id).cloned())
        .unwrap_or_else(|| json!({ "status": "unknown" }));
    Ok(status)
}

#[tauri::command]
pub fn browser_action(
    account_id: String,
    platform: String,
    action: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let req = json!({
        "cmd": "action",
        "accountId": account_id,
        "platform": platform,
        "action": action,
        "params": params.unwrap_or(json!({})),
    });
    run_worker(req, Duration::from_secs(360))
}

/// Publish a post through the browser (blocking). Used by the scheduler for
/// accounts with `auth_type = "browser"`.
pub fn post(
    account_id: &str,
    platform: &str,
    content: &str,
    media_paths: &[String],
) -> Result<String, String> {
    let req = json!({
        "cmd": "action",
        "accountId": account_id,
        "platform": platform,
        "action": "post",
        "params": { "content": content, "mediaPaths": media_paths },
    });

    let resp = run_worker(req, Duration::from_secs(360))?;

    if resp.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return Err(resp
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("browser worker error")
            .to_string());
    }

    let data = resp.get("data").cloned().unwrap_or(json!({}));
    if let Some(err) = data.get("error").and_then(|x| x.as_str()) {
        return Err(err.to_string());
    }

    Ok(format!(
        "browser_{}",
        data.get("url").and_then(|x| x.as_str()).unwrap_or("posted")
    ))
}
