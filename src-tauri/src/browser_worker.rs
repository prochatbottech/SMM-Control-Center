//! Runs the Playwright browser-automation worker (Node) as a short-lived child
//! process per request. This keeps `automation/worker.mjs` changes effective
//! without restarting the app and avoids a stuck long-lived worker.
//!
//! Runtime resolution order for every dependency is deliberately explicit so a
//! packaged build can explain *what* is missing instead of failing with a bare
//! "spawn node: not found":
//!   * worker script: env override -> bundled resource dir -> dev tree
//!   * node binary:   env override -> bundled sidecar -> PATH
//!   * playwright:    env override -> bundled `node_modules` next to the script

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;

static PROFILES_DIR: OnceLock<String> = OnceLock::new();
static LOGIN_STATUS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();

/// Absolute paths resolved once at startup (packaged) or on demand (dev).
#[derive(Debug, Clone, Default)]
pub struct RuntimePaths {
    pub script: Option<PathBuf>,
    pub playwright_module: Option<PathBuf>,
    pub node: Option<PathBuf>,
    pub source: String,
}

static RUNTIME: OnceLock<Mutex<RuntimePaths>> = OnceLock::new();

fn runtime_slot() -> &'static Mutex<RuntimePaths> {
    RUNTIME.get_or_init(|| Mutex::new(RuntimePaths::default()))
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Candidate directories that may contain `automation/worker.mjs`, most trusted first.
fn script_roots(app: Option<&tauri::AppHandle>) -> Vec<(PathBuf, String)> {
    let mut roots: Vec<(PathBuf, String)> = Vec::new();

    if let Some(app) = app {
        if let Ok(dir) = app.path().resource_dir() {
            roots.push((dir, "resource".to_string()));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        roots.push((cwd, "cwd".to_string()));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push((dir.to_path_buf(), "exe".to_string()));
        }
    }

    roots
}

/// Locate `automation/worker.mjs` and cache the result.
fn resolve_runtime(app: Option<&tauri::AppHandle>) -> RuntimePaths {
    if let Some(script) = env_path("BROWSER_WORKER_SCRIPT") {
        let mut paths = RuntimePaths {
            playwright_module: env_path("PLAYWRIGHT_MODULE_PATH"),
            node: env_path("BROWSER_NODE_BIN"),
            source: "env".to_string(),
            script: Some(script),
        };
        if paths.playwright_module.is_none() {
            paths.playwright_module = find_playwright_module(paths.script.as_deref());
        }
        if paths.node.is_none() {
            paths.node = Some(PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }));
        }
        return paths;
    }

    let rel = Path::new("automation").join("worker.mjs");

    for (root, source) in script_roots(app) {
        // Packaged layout: resources/automation/worker.mjs or <root>/automation/worker.mjs.
        for base in [root.clone(), root.join("resources")] {
            let candidate = base.join(&rel);
            if candidate.is_file() {
                let playwright_module = find_playwright_module(Some(&candidate));
                return RuntimePaths {
                    script: Some(candidate),
                    playwright_module,
                    node: Some(resolve_node(&base)),
                    source,
                };
            }
        }
    }

    // Dev fallback: walk up from cwd looking for the repository root.
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir: Option<&Path> = Some(cwd.as_path());
        while let Some(d) = dir {
            let candidate = d.join(&rel);
            if candidate.is_file() {
                let playwright_module = find_playwright_module(Some(&candidate));
                return RuntimePaths {
                    script: Some(candidate),
                    playwright_module,
                    node: Some(resolve_node(d)),
                    source: "dev".to_string(),
                };
            }
            dir = d.parent();
        }
    }

    RuntimePaths {
        script: None,
        playwright_module: None,
        node: Some(resolve_node(Path::new("."))),
        source: "missing".to_string(),
    }
}

/// Playwright package directory next to the worker script (bundled layout) or in
/// the dev `node_modules` tree, walking up like Node's own resolution so the
/// result does not depend on the process working directory.
fn find_playwright_module(script: Option<&Path>) -> Option<PathBuf> {
    if let Some(module) = env_path("PLAYWRIGHT_MODULE_PATH") {
        return Some(module);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(script) = script {
        let mut dir = script.parent();
        while let Some(current) = dir {
            candidates.push(current.join("node_modules").join("playwright-core"));
            candidates.push(current.join("node_modules").join("playwright"));
            dir = current.parent();
        }
    }

    for candidate in candidates {
        if candidate.join("package.json").is_file() {
            return Some(candidate);
        }
    }

    None
}

/// Bundled Node sidecar (Windows) or the `node` found on PATH.
fn resolve_node(base: &Path) -> PathBuf {
    if let Some(bin) = env_path("BROWSER_NODE_BIN") {
        return bin;
    }

    let sidecar = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in [base.to_path_buf(), base.join("automation"), base.join("bin")] {
        let candidate = dir.join(sidecar);
        if candidate.is_file() {
            return candidate;
        }
    }

    PathBuf::from(sidecar)
}

/// Resolve and cache the runtime at startup so scheduled posts work after a
/// restart without a prior manual login call.
pub fn init(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        PROFILES_DIR.get_or_init(|| {
            dir.join("browser_profiles")
                .to_string_lossy()
                .to_string()
        });
    }

    let resolved = resolve_runtime(Some(app));
    if let Ok(mut slot) = runtime_slot().lock() {
        *slot = resolved;
    }
}

fn cached_runtime() -> RuntimePaths {
    runtime_slot()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn ensure_runtime(app: Option<&tauri::AppHandle>) -> RuntimePaths {
    let cached = cached_runtime();
    if cached.script.is_some() {
        return cached;
    }

    let resolved = resolve_runtime(app);
    if let Ok(mut slot) = runtime_slot().lock() {
        *slot = resolved.clone();
    }
    resolved
}

/// Human-readable description of the resolved runtime, used by diagnostics.
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeDiagnostics {
    pub ok: bool,
    pub source: String,
    pub script: Option<String>,
    pub playwright_module: Option<String>,
    pub node: Option<String>,
    pub node_version: Option<String>,
    pub profiles_dir: Option<String>,
    pub issues: Vec<String>,
}

/// Probe the worker once and report what is available. Used by the UI so a broken
/// installation surfaces as an actionable message instead of a failed post.
pub fn diagnostics(app: Option<&tauri::AppHandle>) -> RuntimeDiagnostics {
    let runtime = ensure_runtime(app);
    let mut issues: Vec<String> = Vec::new();

    let script = runtime.script.as_ref().map(|p| p.to_string_lossy().to_string());
    match &runtime.script {
        Some(path) if path.is_file() => {}
        Some(path) => issues.push(format!(
            "Файл воркера не найден: {}",
            path.to_string_lossy()
        )),
        None => issues.push(
            "automation/worker.mjs не найден ни в ресурсах приложения, ни в папке проекта".to_string(),
        ),
    }

    let playwright_module = runtime
        .playwright_module
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    if runtime.playwright_module.is_none() {
        issues.push(
            "Playwright не найден. Выполните `pnpm prepare:automation` и пересоберите приложение"
                .to_string(),
        );
    }

    let node = runtime.node.as_ref().map(|p| p.to_string_lossy().to_string());
    let mut node_version = None;
    if let Some(bin) = &runtime.node {
        match Command::new(bin).arg("--version").output() {
            Ok(out) if out.status.success() => {
                node_version = Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
            }
            Ok(out) => issues.push(format!(
                "Node.js {} завершился с ошибкой: {}",
                bin.to_string_lossy(),
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => issues.push(format!(
                "Node.js не запускается ({}): {}. Установите Node.js 20+ или соберите приложение с упакованным рантаймом",
                bin.to_string_lossy(),
                e
            )),
        }
    }

    // A real round-trip proves the whole chain: node -> worker -> playwright import.
    if issues.is_empty() {
        match run_worker_with(app, json!({ "cmd": "ping" }), Duration::from_secs(45)) {
            Ok(v) => {
                let data = v.get("data").cloned().unwrap_or(json!({}));
                if let Some(v) = data.get("node").and_then(|x| x.as_str()) {
                    node_version = Some(v.to_string());
                }
            }
            Err(e) => issues.push(format!("Проверка воркера не удалась: {}", e)),
        }
    }

    RuntimeDiagnostics {
        ok: issues.is_empty(),
        source: runtime.source,
        script,
        playwright_module,
        node,
        node_version,
        profiles_dir: PROFILES_DIR.get().cloned(),
        issues,
    }
}

/// Spawn the worker for a single request, feed it one JSON line, and return the
/// matching response. The process exits after processing (stdin closed).
fn run_worker_with(
    app: Option<&tauri::AppHandle>,
    req: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let runtime = ensure_runtime(app);

    let script = runtime.script.as_ref().ok_or_else(|| {
        "Не найден automation/worker.mjs. Пересоберите приложение (`pnpm tauri:build`) \
         или укажите путь через BROWSER_WORKER_SCRIPT"
            .to_string()
    })?;

    let node = runtime
        .node
        .clone()
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }));

    let profiles = PROFILES_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| "browser_profiles".to_string());

    let mut command = Command::new(&node);
    command
        .arg(script)
        .env("BROWSER_PROFILES_DIR", &profiles)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    if let Some(module) = &runtime.playwright_module {
        command.env("PLAYWRIGHT_MODULE_PATH", module);
    }

    // Keep the browser download out of the app resources: a per-user cache is the
    // only writable location for Playwright-managed Chromium.
    if let Some(app) = app {
        if let Ok(dir) = app.path().app_data_dir() {
            command.env("PLAYWRIGHT_BROWSERS_PATH", dir.join("playwright_browsers"));
        }
    }

    let mut child = command.spawn().map_err(|e| {
        format!(
            "Не удалось запустить Node.js ({}): {}. Проверьте, что Node.js 20+ установлен",
            node.to_string_lossy(),
            e
        )
    })?;

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
    ensure_runtime(Some(&app));

    let status = LOGIN_STATUS.get_or_init(|| Mutex::new(HashMap::new()));
    status
        .lock()
        .unwrap()
        .insert(account_id.clone(), json!({ "status": "pending" }));

    let account_id_for_thread = account_id.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let req = json!({ "cmd": "login", "accountId": account_id_for_thread, "platform": platform });
        let result = match run_worker_with(Some(&app_handle), req, Duration::from_secs(360)) {
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

/// Report whether the browser automation runtime is usable in this installation.
#[tauri::command]
pub async fn browser_runtime_status(app: tauri::AppHandle) -> Result<RuntimeDiagnostics, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || diagnostics(Some(&handle)))
        .await
        .map_err(|e| format!("diagnostics task failed: {}", e))
}

#[tauri::command]
pub fn browser_action(
    app: tauri::AppHandle,
    account_id: String,
    platform: String,
    action: String,
    params: Option<Value>,
) -> Result<Value, String> {
    browser_action_with_timeout(
        Some(&app),
        account_id,
        platform,
        action,
        params,
        Duration::from_secs(360),
    )
}

/// Same as `browser_action` but with a caller-provided timeout (long batch jobs).
pub fn browser_action_with_timeout(
    app: Option<&tauri::AppHandle>,
    account_id: String,
    platform: String,
    action: String,
    params: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let req = json!({
        "cmd": "action",
        "accountId": account_id,
        "platform": platform,
        "action": action,
        "params": params.unwrap_or(json!({})),
    });
    run_worker_with(app, req, timeout)
}

/// Publish a post through the browser (blocking). Used by the scheduler for
/// accounts with `auth_type = "browser"`.
pub fn post(
    app: Option<&tauri::AppHandle>,
    account_id: &str,
    platform: &str,
    content: &str,
    media_paths: &[String],
    target_id: Option<&str>,
) -> Result<String, String> {
    let req = json!({
        "cmd": "action",
        "accountId": account_id,
        "platform": platform,
        "action": "post",
        "params": {
            "content": content,
            "mediaPaths": media_paths,
            "targetId": target_id.unwrap_or(""),
        },
    });

    let resp = run_worker_with(app, req, Duration::from_secs(360))?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_playwright_module_in_dev_tree() {
        // In the repository the dev tree has playwright-core under node_modules.
        let module = find_playwright_module(None);
        if let Some(path) = module {
            assert!(path.join("package.json").is_file());
        }
    }

    #[test]
    fn test_resolve_node_env_override_and_path_fallback() {
        // Both scenarios mutate the same process env, so they must run in one
        // test: cargo runs tests in parallel and would race on the variable.
        let previous = std::env::var_os("BROWSER_NODE_BIN");

        unsafe { std::env::set_var("BROWSER_NODE_BIN", "custom-node") };
        assert_eq!(resolve_node(Path::new(".")), PathBuf::from("custom-node"));

        unsafe { std::env::remove_var("BROWSER_NODE_BIN") };
        let fallback = resolve_node(Path::new("Z:/definitely/not/a/real/dir"));
        assert_eq!(
            fallback,
            PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }),
            "without an override or a sidecar the bare binary name is used"
        );

        match previous {
            Some(v) => unsafe { std::env::set_var("BROWSER_NODE_BIN", v) },
            None => unsafe { std::env::remove_var("BROWSER_NODE_BIN") },
        }
    }
}
