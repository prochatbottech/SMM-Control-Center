//! Manages the Playwright browser-automation worker (Node) as a child process
//! and exposes Tauri commands for login and actions for VK / OK.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
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

static WORKER: OnceLock<Worker> = OnceLock::new();
static PROFILES_DIR: OnceLock<String> = OnceLock::new();
static LOGIN_STATUS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();

fn worker_script() -> String {
    std::env::var("BROWSER_WORKER_SCRIPT").unwrap_or_else(|_| "automation/worker.mjs".to_string())
}

fn ensure_worker() -> &'static Worker {
    WORKER.get_or_init(|| {
        let profiles_dir = PROFILES_DIR
            .get()
            .cloned()
            .unwrap_or_else(|| "browser_profiles".to_string());

        let mut child = Command::new("node")
            .arg(worker_script())
            .env("BROWSER_PROFILES_DIR", &profiles_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("failed to spawn browser automation worker");

        let stdin = child.stdin.take().expect("worker stdin");
        let stdout = child.stdout.take().expect("worker stdout");

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

        Worker {
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            _child: child,
        }
    })
}

fn send_request(req: Value) -> Result<Value, String> {
    let worker = ensure_worker();
    let id = worker.next_id.fetch_add(1, Ordering::SeqCst);

    let (tx, rx): (Sender<Value>, Receiver<Value>) = channel();
    worker.pending.lock().unwrap().insert(id, tx);

    let mut req = req;
    req["id"] = json!(id);
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";

    let mut stdin = worker.stdin.lock().unwrap();
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    drop(stdin);

    rx.recv_timeout(Duration::from_secs(360))
        .map_err(|e| format!("Browser worker timeout: {}", e))
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
        if let Some(map) = LOGIN_STATUS.get() {
            map.lock().unwrap().insert(account_id_for_thread.clone(), result);
        }
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

/// Run a browser action with a persisted session. Currently supports `get_url`.
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

    Ok(format!("browser_{}", data.get("url").and_then(|x| x.as_str()).unwrap_or("posted")))
}
