//! Browser automation bridge (CDP mode).
//!
//! The app no longer launches its own Playwright-managed browser. A long-lived
//! Node worker connects to a *user-owned* Yandex Browser instance over the Chrome
//! DevTools Protocol (`--remote-debugging-port`), so VK/OK actions run inside a
//! real, already authenticated profile instead of an automation profile that the
//! anti-bot readily recognises.
//!
//! Runtime resolution order for every dependency is deliberately explicit so a
//! packaged build can explain *what* is missing instead of failing with a bare
//! "spawn node: not found":
//!   * worker script: env override -> bundled resource dir -> dev tree
//!   * node binary:   env override -> bundled sidecar -> PATH
//!   * playwright:    env override -> bundled `node_modules` next to the script
//!   * browser:       a running browser listening on `CDP_URL` (never started here)

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;

/// CDP endpoint of the dedicated Yandex Browser profile. Kept off 9222 so the
/// usual devtools/`chrome://inspect` port stays free.
pub const CDP_URL: &str = "http://127.0.0.1:9223";

/// Budget for a single browser task. The worker may spend up to 5 minutes of it
/// waiting for the user to solve a VK captcha in the visible window, so this has
/// to stay comfortably above that: a task killed mid-captcha both fails and
/// leaves the browser sitting on the challenge page.
pub const DEFAULT_ACTION_TIMEOUT: Duration = Duration::from_secs(600);

/// Only one browser action may run at a time: over CDP there is a single context
/// and a single page, so concurrent tasks would fight over the same tab.
static ACTION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Shared state of the long-lived worker process.
static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();

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

/// Strip the Windows `\\?\` prefix so the path is a plain `C:\...` string.
/// Node.js v22+ chokes on `\\?\C:` when it calls `lstat` on a child import
/// (the string is parsed as a UNC path whose share name is `"C:"`).
fn normalize_win_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        p.to_path_buf()
    }
}

fn env_str(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// CDP endpoint to use, overridable for users who run the browser on another port.
fn cdp_url() -> String {
    env_str("SMM_CDP_URL").unwrap_or_else(|| CDP_URL.to_string())
}

/// Candidate directories that may contain `automation/worker.mjs`, most trusted first.
fn script_roots(app: Option<&tauri::AppHandle>) -> Vec<(PathBuf, String)> {
    let mut roots: Vec<(PathBuf, String)> = Vec::new();

    if let Some(app) = app {
        if let Ok(dir) = app.path().resource_dir() {
            roots.push((normalize_win_path(&dir), "resource".to_string()));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        roots.push((normalize_win_path(&cwd), "cwd".to_string()));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push((normalize_win_path(dir), "exe".to_string()));
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
/// restart without a prior manual check.
pub fn init(app: &tauri::AppHandle) {
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

// ---------------------------------------------------------------------------
// CDP reachability
// ---------------------------------------------------------------------------

/// Cheap liveness probe for the browser's DevTools port. A failed TCP connect
/// means the dedicated browser profile is simply not running, which is a very
/// different user action than "Playwright is missing".
fn cdp_reachable(timeout: Duration) -> bool {
    let url = cdp_url();
    let host_port = url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string();

    // Split "127.0.0.1:9223" without pulling in a URL parser.
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().unwrap_or(9223)),
        None => (host_port.clone(), 9223),
    };

    let ip: std::net::IpAddr = match host.parse() {
        Ok(ip) => ip,
        // "localhost" and anything non-numeric: the CDP endpoint is always local.
        Err(_) => std::net::Ipv4Addr::LOCALHOST.into(),
    };

    TcpStream::connect_timeout(&std::net::SocketAddr::new(ip, port), timeout)
        .map(|socket| {
            let _ = socket.shutdown(Shutdown::Both);
            true
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Long-lived worker process
// ---------------------------------------------------------------------------

struct Worker {
    child: Child,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    /// stderr tail, kept for actionable error messages.
    stderr: Arc<Mutex<String>>,
    next_id: u64,
}

fn worker_slot() -> &'static Mutex<Option<Worker>> {
    WORKER.get_or_init(|| Mutex::new(None))
}

/// Spawns the worker if it is not alive yet and returns a guard to it.
///
/// The worker is deliberately *not* killed when a request times out: it owns a
/// CDP connection to the user's own browser, and a slow page must never take the
/// browser down with it.
fn ensure_worker(app: Option<&tauri::AppHandle>) -> Result<(), String> {
    let mut guard = worker_slot()
        .lock()
        .map_err(|_| "worker mutex poisoned".to_string())?;

    if let Some(worker) = guard.as_mut() {
        match worker.child.try_wait() {
            Ok(None) => return Ok(()),
            // Exited (crash, machine wake, manual kill): fall through and respawn.
            Ok(Some(_)) | Err(_) => {
                eprintln!("[browser-worker] previous worker is gone, respawning");
            }
        }
    }
    *guard = None;

    let runtime = ensure_runtime(app);
    let script = runtime.script.as_ref().ok_or_else(|| {
        "Не найден automation/worker.mjs. Пересоберите приложение (`pnpm tauri build`) \
         или укажите путь через BROWSER_WORKER_SCRIPT"
            .to_string()
    })?;

    // Tauri's resource_dir()/current_exe() return Windows verbatim paths
    // (`\\?\C:\...`). Node misparses them: `\\?\C:` looks like a UNC path whose
    // share is "C:", so `lstat` inside Playwright's import fails with
    // `EISDIR: illegal operation on a directory, lstat 'C:'` and the worker
    // dies before answering. Hand plain paths to the child process instead.
    let node = runtime
        .node
        .clone()
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }));

    let script = normalize_win_path(script);
    let node = normalize_win_path(&node);

    let mut command = Command::new(&node);
    command
        .arg(&script)
        .env("SMM_CDP_URL", cdp_url())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Captured, not inherited: in a GUI build there is no console, so an
        // unhandled worker exception would vanish and surface only as
        // "worker closed without response".
        .stderr(Stdio::piped());

    if let Some(module) = &runtime.playwright_module {
        command.env("PLAYWRIGHT_MODULE_PATH", normalize_win_path(module));
    }

    let mut child = command.spawn().map_err(|e| {
        format!(
            "Не удалось запустить Node.js ({}): {}. Проверьте, что Node.js 20+ установлен",
            node.to_string_lossy(),
            e
        )
    })?;

    let stdin = child.stdin.take().ok_or("worker has no stdin")?;
    let stdout = child.stdout.take().ok_or("worker has no stdout")?;
    let stderr = child.stderr.take();

    let pending = pending_map();
    // Anything left over from the previous process can never be answered.
    if let Ok(mut map) = pending.lock() {
        map.clear();
    }
    let stderr_log = Arc::new(Mutex::new(String::new()));

    // Reader thread: route every response line to whoever is waiting for its id.
    {
        let pending = pending.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                // Startup announcement carries no id — log it and move on.
                let Some(id) = value.get("id").and_then(|x| x.as_u64()) else {
                    eprintln!("[browser-worker] {}", line.chars().take(300).collect::<String>());
                    continue;
                };
                if let Ok(mut map) = pending.lock() {
                    if let Some(tx) = map.remove(&id) {
                        let _ = tx.send(value);
                    }
                }
            }
            // EOF: nobody will answer the queued requests anymore.
            if let Ok(mut map) = pending.lock() {
                for (_, tx) in map.drain() {
                    let _ = tx.send(json!({ "id": 0, "ok": false, "error": "__worker_exit__" }));
                }
            }
        });
    }

    // stderr must be drained continuously: a full pipe buffer would block the
    // worker forever while we wait for a response that can never be written.
    if let Some(stream) = stderr {
        let sink = stderr_log.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines() {
                let Ok(line) = line else { continue };
                eprintln!("[browser-worker] {}", line);
                if let Ok(mut buf) = sink.lock() {
                    if buf.len() < 4000 {
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                }
            }
        });
    }

    *guard = Some(Worker {
        child,
        stdin: Arc::new(Mutex::new(stdin)),
        stderr: stderr_log,
        next_id: 1,
    });

    eprintln!(
        "[browser-worker] started ({} -> {}, CDP {})",
        node.to_string_lossy(),
        script.to_string_lossy(),
        cdp_url()
    );

    Ok(())
}

/// Sends one request to the long-lived worker and waits for its response.
///
/// `exclusive` actions (posting, parsing, friend requests) serialise on
/// `ACTION_LOCK` because they all drive the same browser tab.
fn request(
    app: Option<&tauri::AppHandle>,
    req: Value,
    timeout: Duration,
    exclusive: bool,
) -> Result<Value, String> {
    // Held for the whole call, released when this function returns.
    let _guard = if exclusive {
        match ACTION_LOCK.get_or_init(|| Mutex::new(())).lock() {
            Ok(guard) => Some(guard),
            Err(_) => None,
        }
    } else {
        None
    };

    ensure_worker(app)?;

    let slot = worker_slot();
    let mut guard = slot
        .lock()
        .map_err(|_| "worker mutex poisoned".to_string())?;
    let worker = guard.as_mut().ok_or("worker is not running")?;

    let id = worker.next_id;
    let next_id = worker.next_id + 1;
    let mut req = req;
    req["id"] = json!(id);

    let (tx, rx): (Sender<Value>, Receiver<Value>) = channel();
    let pending = pending_map();
    if let Ok(mut map) = pending.lock() {
        map.insert(id, tx);
    }

    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";
    let write_result = {
        let mut stdin = worker
            .stdin
            .lock()
            .map_err(|_| "worker stdin mutex poisoned".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| {
                format!(
                    "Не удалось отправить команду браузеру: {}. \
                     Закройте все окна браузера и запустите его заново",
                    e
                )
            })
    };
    worker.next_id = next_id;
    if write_result.is_err() {
        if let Ok(mut map) = pending.lock() {
            map.remove(&id);
        }
    }
    write_result?;

    // Drop the worker guard before waiting: the reader thread needs the pending
    // map, and holding this lock would also block every other caller.
    drop(guard);

    match rx.recv_timeout(timeout) {
        Ok(value) => {
            if value.get("error").and_then(|x| x.as_str()) == Some("__worker_exit__") {
                let reason = summarize_worker_stderr(&stderr_tail());
                return Err(format!(
                    "Процесс автоматизации завершился, не прислав ответ: {}. \
                     Проверьте, что браузер с выделенным профилем запущен, и повторите",
                    reason
                ));
            }
            Ok(value)
        }
        Err(_) => {
            // Drop the orphaned sender: the reader thread can no longer answer it,
            // and keeping it would leak a channel per timed-out request.
            if let Ok(mut map) = pending.lock() {
                map.remove(&id);
            }
            let reason = summarize_worker_stderr(&stderr_tail());
            Err(format!(
                "Браузер не ответил за {} с ({}). Убедитесь, что окно браузера не занято \
                 вручную и страница загрузилась",
                timeout.as_secs(),
                reason
            ))
        }
    }
}

/// In-flight requests by id. Shared by the reader thread and every caller, so a
/// response can be routed without holding the worker lock.
fn pending_map() -> Arc<Mutex<HashMap<u64, Sender<Value>>>> {
    static PENDING: OnceLock<Arc<Mutex<HashMap<u64, Sender<Value>>>>> = OnceLock::new();
    PENDING
        .get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
        .clone()
}

fn stderr_tail() -> String {
    worker_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|worker| worker.stderr.lock().ok().map(|b| b.clone())))
        .unwrap_or_default()
}

/// Picks the most informative line out of worker stderr: the last line that looks
/// like an error, falling back to the last non-empty line.
fn summarize_worker_stderr(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("(Use `node --trace-warnings"))
        .filter(|l| !l.contains("[MODULE_TYPELESS_PACKAGE_JSON]"))
        .filter(|l| !l.starts_with("Reparsing as ES module"))
        .filter(|l| !l.starts_with("To eliminate this warning"))
        .collect();

    let chosen = lines
        .iter()
        .rev()
        .find(|l| {
            l.starts_with("Error") || l.contains("Error:") || l.contains("error") || l.contains("Timeout")
        })
        .or_else(|| lines.last());

    match chosen {
        Some(line) => line.chars().take(300).collect(),
        None => "без диагностического вывода".to_string(),
    }
}

/// Restarts the worker process (kept for diagnostics and the "reconnect" button).
fn restart_worker(app: Option<&tauri::AppHandle>) -> Result<(), String> {
    if let Ok(mut guard) = worker_slot().lock() {
        if let Some(mut worker) = guard.take() {
            let _ = worker.child.kill();
            let _ = worker.child.wait();
        }
    }
    ensure_worker(app)
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Human-readable description of the runtime, used by the UI banner.
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeDiagnostics {
    pub ok: bool,
    pub source: String,
    pub script: Option<String>,
    pub playwright_module: Option<String>,
    pub node: Option<String>,
    pub node_version: Option<String>,
    pub cdp_url: String,
    pub cdp_reachable: bool,
    pub browser_connected: bool,
    pub browser_pages: Option<u32>,
    pub issues: Vec<String>,
}

/// Probes the whole chain: node -> worker -> Playwright -> CDP -> browser.
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

    let reachable = cdp_reachable(Duration::from_millis(800));
    let mut browser_connected = false;
    let mut browser_pages = None;

    if !reachable {
        issues.push(format!(
            "Браузер с выделенным профилем не запущен ({} не отвечает). \
             Запустите его скриптом «Запустить Яндекс.Браузер» и войдите в VK/OK",
            cdp_url()
        ));
    } else if issues.is_empty() {
        // A real round-trip proves the whole chain: node -> worker -> playwright -> CDP.
        match request(app, json!({ "cmd": "ping" }), Duration::from_secs(60), false) {
            Ok(v) => {
                let data = v.get("data").cloned().unwrap_or(json!({}));
                if let Some(v) = data.get("node").and_then(|x| x.as_str()) {
                    node_version = Some(v.to_string());
                }
                browser_connected = data.get("connected").and_then(|x| x.as_bool()).unwrap_or(false);
                browser_pages = data.get("openPages").and_then(|x| x.as_u64()).map(|v| v as u32);
                if !browser_connected {
                    if let Some(err) = data.get("error").and_then(|x| x.as_str()) {
                        issues.push(format!(
                            "Не удалось подключиться к браузеру: {}. \
                             Перезапустите браузер скриптом запуска профиля",
                            err
                        ));
                    } else {
                        issues.push(
                            "Порт браузера отвечает, но Playwright не смог подключиться. \
                             Перезапустите браузер скриптом запуска профиля"
                                .to_string(),
                        );
                    }
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
        cdp_url: cdp_url(),
        cdp_reachable: reachable,
        browser_connected,
        browser_pages,
        issues,
    }
}

/// Restart + ping, so the UI can offer a single "reconnect" action.
#[tauri::command]
pub async fn browser_reconnect(app: tauri::AppHandle) -> Result<RuntimeDiagnostics, String> {
    tokio::task::spawn_blocking(move || {
        let _ = restart_worker(Some(&app));
        diagnostics(Some(&app))
    })
    .await
    .map_err(|e| format!("reconnect task failed: {}", e))
}

/// Report whether the browser automation runtime is usable in this installation.
#[tauri::command]
pub async fn browser_runtime_status(app: tauri::AppHandle) -> Result<RuntimeDiagnostics, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || diagnostics(Some(&handle)))
        .await
        .map_err(|e| format!("diagnostics task failed: {}", e))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn set_login_status(account_id: &str, status: Value) {
    if let Some(map) = LOGIN_STATUS.get() {
        map.lock().unwrap().insert(account_id.to_string(), status);
    }
}

/// In CDP mode the app never drives a login form: the user authenticates in the
/// dedicated browser window themselves. This command verifies that the session is
/// actually present and reports the result the same way the old login flow did.
#[tauri::command]
pub fn browser_login_start(
    app: tauri::AppHandle,
    account_id: String,
    platform: String,
) -> Result<Value, String> {
    ensure_runtime(Some(&app));

    let status = LOGIN_STATUS.get_or_init(|| Mutex::new(HashMap::new()));
    status
        .lock()
        .unwrap()
        .insert(account_id.clone(), json!({ "status": "pending" }));

    let account_id_for_thread = account_id.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let req = json!({
            "cmd": "action",
            "accountId": account_id_for_thread.clone(),
            "platform": platform.clone(),
            "action": "check_auth",
            "params": {},
        });
        let result = match request(Some(&app_handle), req, Duration::from_secs(120), true) {
            Ok(v) if v.get("ok").and_then(|x| x.as_bool()) == Some(true) => {
                let data = v.get("data").cloned().unwrap_or(json!({}));
                if data.get("loggedIn").and_then(|x| x.as_bool()) == Some(true) {
                    json!({ "status": "success", "url": data.get("url") })
                } else {
                    json!({
                        "status": "error",
                        "error": format!(
                            "В аккаунте нет активной сессии ({}). Откройте окно браузера с выделенным \
                             профилем и войдите вручную",
                            data.get("reason")
                                .and_then(|x| x.as_str())
                                .unwrap_or("не авторизован")
                        ),
                    })
                }
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
        DEFAULT_ACTION_TIMEOUT,
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
    request(app, req, timeout, true)
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

    let resp = request(app, req, DEFAULT_ACTION_TIMEOUT, true)?;

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
    use std::time::Instant;

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

    #[test]
    fn test_cdp_probe_rejects_closed_port() {
        // Nothing listens on 65001, so the probe must fail fast instead of hanging.
        unsafe { std::env::set_var("SMM_CDP_URL", "http://127.0.0.1:65001") };
        let start = Instant::now();
        let reachable = cdp_reachable(Duration::from_millis(500));
        unsafe { std::env::remove_var("SMM_CDP_URL") };

        assert!(!reachable, "a closed port must not look reachable");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "probe must respect its own timeout"
        );
    }

    #[test]
    fn test_summarize_worker_stderr_prefers_error_line() {
        let stderr = "(node:1) Warning: something\nError: EACCES: permission denied\n";
        assert!(summarize_worker_stderr(stderr).starts_with("Error:"));
        assert_eq!(
            summarize_worker_stderr(""),
            "без диагностического вывода"
        );
    }

    #[test]
    fn test_normalize_win_path_strips_verbatim_prefix() {
        // Node parses `\\?\C:` as a UNC path with share "C:", which breaks
        // Playwright's internal lstat calls. The prefix must be gone.
        let verbatim = Path::new(r"\\?\C:\Users\potsh\AppData\Local\smm-control-center\automation\worker.mjs");
        let normalized = normalize_win_path(verbatim);
        assert_eq!(
            normalized,
            PathBuf::from(r"C:\Users\potsh\AppData\Local\smm-control-center\automation\worker.mjs")
        );

        // Plain and UNC paths are passed through untouched.
        let plain = Path::new(r"C:\Users\potsh\worker.mjs");
        assert_eq!(normalize_win_path(plain), plain.to_path_buf());
        let unc = Path::new(r"\\server\share\worker.mjs");
        assert_eq!(normalize_win_path(unc), unc.to_path_buf());
    }
}
