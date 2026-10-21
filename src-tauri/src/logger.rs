use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const EVENT_SYSTEM_LOG: &str = "system-log";

/// Payload for live system logs emitted to the frontend
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LogPayload {
    pub level: String, // "info" | "warn" | "error" | "success"
    pub message: String,
    pub timestamp: i64,
}

impl LogPayload {
    pub fn new(level: &str, message: &str) -> Self {
        Self {
            level: level.to_string(),
            message: message.to_string(),
            timestamp: chrono::Utc::now().timestamp(),
        }
    }
}

/// Emit a structured log event to the Tauri frontend via "system-log" event.
/// Invariant: Redaction 3.0: Never log raw objects or unmasked tokens.
pub fn emit_log(app: &AppHandle, level: &str, message: &str) {
    let payload = LogPayload::new(level, message);
    let _ = app.emit(EVENT_SYSTEM_LOG, &payload);

    match level {
        "error" => eprintln!("[{}] {}", level.to_uppercase(), message),
        _ => println!("[{}] {}", level.to_uppercase(), message),
    }
}

/// Emit log if AppHandle is provided (production), or log to console if None (e.g. unit tests)
pub fn emit_log_opt(app: Option<&AppHandle>, level: &str, message: &str) {
    if let Some(app) = app {
        emit_log(app, level, message);
    } else {
        match level {
            "error" => eprintln!("[{}] {}", level.to_uppercase(), message),
            _ => println!("[{}] {}", level.to_uppercase(), message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_payload_serialization() {
        let payload = LogPayload {
            level: "info".to_string(),
            message: "Scheduler worker initialized".to_string(),
            timestamp: 1715000000,
        };

        let json = serde_json::to_string(&payload).expect("Must serialize");
        assert!(json.contains(r#""level":"info""#));
        assert!(json.contains(r#""message":"Scheduler worker initialized""#));
        assert!(json.contains(r#""timestamp":1715000000"#));

        let deserialized: LogPayload = serde_json::from_str(&json).expect("Must deserialize");
        assert_eq!(deserialized, payload);
    }

    #[test]
    fn test_emit_log_opt_without_app() {
        // Must not panic when AppHandle is None in unit tests
        emit_log_opt(None, "info", "Testing headless logger");
        emit_log_opt(None, "error", "Testing headless error logger");
    }
}
