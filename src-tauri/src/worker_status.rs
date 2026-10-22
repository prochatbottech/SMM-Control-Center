use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use serde::Serialize;

pub const SCHEDULER_INTERVAL_SECS: u64 = 30;
pub const AUTOMATION_INTERVAL_SECS: u64 = 15;

static SCHEDULER_RUNNING: AtomicBool = AtomicBool::new(false);
static SCHEDULER_LAST_RUN_AT: AtomicI64 = AtomicI64::new(0);
static SCHEDULER_PROCESSED: AtomicU64 = AtomicU64::new(0);

static AUTOMATION_RUNNING: AtomicBool = AtomicBool::new(false);
static AUTOMATION_LAST_RUN_AT: AtomicI64 = AtomicI64::new(0);
static AUTOMATION_PROCESSED: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
pub struct WorkerInfo {
    pub running: bool,
    pub last_run_at: Option<i64>,
    pub processed_count: u64,
    pub interval_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkerStatus {
    pub scheduler: WorkerInfo,
    pub automation: WorkerInfo,
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn scheduler_set_running() {
    SCHEDULER_RUNNING.store(true, Ordering::Relaxed);
}

pub fn scheduler_record_iteration(processed: usize) {
    SCHEDULER_LAST_RUN_AT.store(now_ts(), Ordering::Relaxed);
    SCHEDULER_PROCESSED.fetch_add(processed as u64, Ordering::Relaxed);
}

pub fn automation_set_running() {
    AUTOMATION_RUNNING.store(true, Ordering::Relaxed);
}

pub fn automation_record_iteration(processed: usize) {
    AUTOMATION_LAST_RUN_AT.store(now_ts(), Ordering::Relaxed);
    AUTOMATION_PROCESSED.fetch_add(processed as u64, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_worker_status() -> WorkerStatus {
    WorkerStatus {
        scheduler: WorkerInfo {
            running: SCHEDULER_RUNNING.load(Ordering::Relaxed),
            last_run_at: {
                let v = SCHEDULER_LAST_RUN_AT.load(Ordering::Relaxed);
                if v == 0 { None } else { Some(v) }
            },
            processed_count: SCHEDULER_PROCESSED.load(Ordering::Relaxed),
            interval_secs: SCHEDULER_INTERVAL_SECS,
        },
        automation: WorkerInfo {
            running: AUTOMATION_RUNNING.load(Ordering::Relaxed),
            last_run_at: {
                let v = AUTOMATION_LAST_RUN_AT.load(Ordering::Relaxed);
                if v == 0 { None } else { Some(v) }
            },
            processed_count: AUTOMATION_PROCESSED.load(Ordering::Relaxed),
            interval_secs: AUTOMATION_INTERVAL_SECS,
        },
    }
}
