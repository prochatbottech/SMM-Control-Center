use std::path::Path;
use tauri::{AppHandle, Manager, State};
use crate::db::{self, DbState};
use crate::logger;

/// Checks if a file begins with the standard 16-byte SQLite header ("SQLite format 3\0")
pub fn is_valid_sqlite_header(path: &Path) -> bool {
    use std::io::Read;
    if let Ok(mut file) = std::fs::File::open(path) {
        let mut buffer = [0u8; 16];
        if file.read_exact(&mut buffer).is_ok() {
            return &buffer == b"SQLite format 3\0";
        }
    }
    false
}

/// Tauri Command: Export (hot snapshot) current SQLite database to a single backup file
/// Invariant: Uses VACUUM INTO to guarantee full data integrity without requiring WAL/SHM files.
#[tauri::command]
pub async fn export_database(
    app: AppHandle,
    state: State<'_, DbState>,
    destination_path: String,
) -> Result<(), String> {
    let dest_path = Path::new(&destination_path);

    // If destination already exists, delete it first because SQLite VACUUM INTO fails if the file exists
    if dest_path.exists() {
        std::fs::remove_file(dest_path)
            .map_err(|e| format!("Не удалось удалить существующий файл по пути назначения: {}", e))?;
    }

    // Invariant: Hot Snapshot using VACUUM INTO
    let query_str = format!("VACUUM INTO '{}'", destination_path.replace('\'', "''"));
    sqlx::query(&query_str)
        .execute(&state.pool)
        .await
        .map_err(|e| format!("Ошибка создания снапшота базы данных (VACUUM INTO): {}", e))?;

    logger::emit_log(
        &app,
        "success",
        &format!("Резервная копия базы данных успешно создана: '{}'", destination_path),
    );

    Ok(())
}

/// Tauri Command: Import and restore SQLite database from backup file, then restart application
/// Invariant: Closes connection pool first to flush buffers and release file locks, then copies file and restarts.
#[tauri::command]
pub async fn import_database(
    app: AppHandle,
    state: State<'_, DbState>,
    source_path: String,
) -> Result<(), String> {
    let src_path = Path::new(&source_path);
    if !src_path.exists() {
        return Err(format!("Файл резервной копии '{}' не найден", source_path));
    }

    // Edge Case: Validate SQLite magic header
    if !is_valid_sqlite_header(src_path) {
        return Err("Выбранный файл не является валидной базой данных SQLite (.smmbak)".to_string());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Не удалось определить app_data_dir: {}", e))?;
    let target_db = app_data_dir.join(db::DB_FILE_NAME);

    logger::emit_log(
        &app,
        "info",
        &format!("Восстановление базы из '{}'. Закрытие активных соединений...", source_path),
    );

    // Invariant: Close pool so SQLite flushes WAL/buffers and releases file locks
    state.pool.close().await;

    // Remove existing WAL and SHM files
    let wal_file = app_data_dir.join(format!("{}-wal", db::DB_FILE_NAME));
    let shm_file = app_data_dir.join(format!("{}-shm", db::DB_FILE_NAME));
    let _ = std::fs::remove_file(wal_file);
    let _ = std::fs::remove_file(shm_file);

    // Overwrite database file
    std::fs::copy(src_path, &target_db)
        .map_err(|e| format!("Ошибка копирования файла базы данных: {}", e))?;

    logger::emit_log(
        &app,
        "success",
        "База данных успешно восстановлена. Перезапуск приложения...",
    );

    // Restart application
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_is_valid_sqlite_header() {
        let temp_dir = tempdir().unwrap();
        let valid_file = temp_dir.path().join("test_valid.db");
        let invalid_file = temp_dir.path().join("test_invalid.db");

        // Write valid SQLite 16-byte magic header
        std::fs::write(&valid_file, b"SQLite format 3\0extra_payload_data").unwrap();
        // Write invalid data
        std::fs::write(&invalid_file, b"NOT_A_SQLITE_FILE_CONTENT").unwrap();

        assert!(is_valid_sqlite_header(&valid_file));
        assert!(!is_valid_sqlite_header(&invalid_file));
    }

    #[tokio::test]
    async fn test_vacuum_into_creates_valid_snapshot() {
        let temp_dir = tempdir().unwrap();
        let pool = db::init_db(temp_dir.path()).await.unwrap();

        let backup_path = temp_dir.path().join("backup.smmbak");
        let query_str = format!("VACUUM INTO '{}'", backup_path.to_string_lossy().replace('\'', "''"));

        sqlx::query(&query_str).execute(&pool).await.unwrap();

        assert!(backup_path.exists());
        assert!(is_valid_sqlite_header(&backup_path));
    }
}
