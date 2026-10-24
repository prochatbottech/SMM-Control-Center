//! Manages the Playwright browser-automation worker (Node) as a child process
//! and exposes Tauri commands for login and actions for VK / OK.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

struct Worker {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    next_id: AtomicU64,
    _child: Child,
}

static WORKER: OnceLock<Option<Worker>> = OnceLock::new();
static PROFILES_DIR: OnceLock<String> = OnceLock::new();
static LOGIN_STATUS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();

/// Locate `automation/worker.mjs` robustly: env override, cwd upward, exe upward.
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

fn spawn_worker() -> Result<Worker, String> {
    let profiles_dir = PROFILES_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| "browser_profiles".to_string());
    let script = worker_script();

    let mut child = Command::new("node")
        .arg(&script)
        .env("BROWSER_PROFILES_DIR", &profiles_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn node ({}): {}", script, e))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(id) = v.get("id").and_then(|x| x.as_u64()) else { continue };
            if let Some(tx) = pending_reader.lock().unwrap().remove(&id) {
                let _ = tx.send(v);
            }
        }
    });

    Ok(Worker {
        stdin: Mutex::new(stdin),
        pending,
        next_id: AtomicU64::new(1),
        _child: child,
    })
}

fn ensure_worker() -> Option<&'static Worker> {
    WORKER
        .get_or_init(|| match spawn_worker() {
            Ok(w) => Some(w),
            Err(e) => {
                eprintln!("[browser_worker] worker spawn failed: {}", e);
                None
            }
        })
        .as_ref()
}

fn send_request_with_timeout(req: Value, timeout: Duration) -> Result<Value, String> {
    let worker = ensure_worker().ok_or_else(|| {
        "не удалось запустить браузерный воркер (проверьте node и automation/worker.mjs)"
            .to_string()
    })?;

    let id = worker.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx): (Sender<Value>, Receiver<Value>) = channel();
    worker.pending.lock().unwrap().insert(id, tx);

    let mut req = req;
    req["id"] = json!(id);
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";

    {
        let mut stdin = worker.stdin.lock().unwrap();
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("worker stdin error: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("worker stdin flush error: {}", e))?;
    }

    rx.recv_timeout(timeout)
        .map_err(|e| format!("Browser worker timeout: {}", e))
}

fn send_request(req: Value) -> Result<Value, String> {
    send_request_with_timeout(req, Duration::from_secs(360))
}

fn set_login_status(account_id: &str, status: Value) {
    if let Some(map) = LOGIN_STATUS.get() {
        map.lock().unwrap().insert(account_id.to_string(), status);
    }
}

/// Start a manual (headed) login for an account. Returns immediately; the
/// browser window stays open until the user logs in. Poll `browser_login_status`.
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

    // Fast readiness check so a failed worker surfaces immediately instead of hanging.
    match send_request_with_timeout(json!({ "cmd": "ping" }), Duration::from_secs(20)) {
        Ok(v) if v.get("ok").and_then(|x| x.as_bool()) == Some(true) => {}
        Ok(v) => {
            set_login_status(
                &account_id,
                json!({ "status": "error", "error": format!("воркер не отвечает: {}", v) }),
            );
            return Ok(json!({ "accountId": account_id }));
        }
        Err(e) => {
            set_login_status(&account_id, json!({ "status": "error", "error": e }));
            return Ok(json!({ "accountId": account_id }));
        }
    }

    let account_id_for_thread = account_id.clone();
    std::thread::spawn(move || {
        let req = json!({ "cmd": "login", "accountId": account_id_for_thread, "platform": platform });
        let result = match send_request(req) {
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

/// Run a browser action with a persisted session.
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
    send_request(req)
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

    let resp = send_request(req)?;
    let ok = resp.get("ok").and_then(|x| x.as_bool()) == Some(true);
    if !ok {
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
