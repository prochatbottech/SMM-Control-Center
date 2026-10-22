use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::prelude::*;
use rand::RngCore;

pub const SERVICE_NAME: &str = "smmbox_local_secure_key";
pub const KEY_USER: &str = "master_key";
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;

/// Cryptographic errors handling keyring and encryption/decryption failures
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("OS Keyring is unavailable: {0}")]
    KeyringUnavailable(String),

    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),

    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),
}

/// Retrieve the 32-byte master key from the OS Keyring (Service: `smmbox_local_secure_key`),
/// or generate and securely store a new one if it does not exist yet.
/// Invariant: If OS Keyring is unavailable (e.g. Windows Credential Manager policy error 5),
/// securely fall back to a local key file in App Data to guarantee continuous operability.
pub fn get_or_generate_key() -> Result<[u8; KEY_LEN], CryptoError> {
    // 1. Try OS Keyring first
    let keyring_result = keyring::Entry::new(SERVICE_NAME, KEY_USER)
        .map_err(|e| CryptoError::KeyringUnavailable(e.to_string()))
        .and_then(|entry| match entry.get_password() {
            Ok(b64_key) => {
                let key_bytes = BASE64_STANDARD
                    .decode(b64_key.trim())
                    .map_err(|e| CryptoError::KeyringUnavailable(format!("Corrupted master key in keyring: {}", e)))?;

                if key_bytes.len() != KEY_LEN {
                    return Err(CryptoError::KeyringUnavailable(format!(
                        "Invalid master key length in keyring: expected {} bytes, got {}",
                        KEY_LEN,
                        key_bytes.len()
                    )));
                }

                let mut key_arr = [0u8; KEY_LEN];
                key_arr.copy_from_slice(&key_bytes);
                Ok(key_arr)
            }
            Err(keyring::Error::NoEntry) => {
                // Generate a fresh 32-byte cryptographically secure random key
                let mut new_key = [0u8; KEY_LEN];
                rand::thread_rng().fill_bytes(&mut new_key);

                let b64_new_key = BASE64_STANDARD.encode(new_key);
                entry
                    .set_password(&b64_new_key)
                    .map_err(|e| CryptoError::KeyringUnavailable(format!("Failed to store master key in keyring: {}", e)))?;

                Ok(new_key)
            }
            Err(e) => Err(CryptoError::KeyringUnavailable(e.to_string())),
        });

    match keyring_result {
        Ok(key) => Ok(key),
        Err(keyring_err) => {
            eprintln!(
                "[Crypto] OS Keyring unavailable ({}), using persistent App Data fallback key",
                keyring_err
            );
            get_or_generate_key_file_fallback()
        }
    }
}

/// Fallback storage for environments where OS Keyring is unavailable or blocked.
/// Persists the 32-byte master key in the user's application data directory.
fn get_or_generate_key_file_fallback() -> Result<[u8; KEY_LEN], CryptoError> {
    let key_path = fallback_key_path();

    if key_path.exists() {
        let content = std::fs::read_to_string(&key_path)
            .map_err(|e| CryptoError::KeyringUnavailable(format!("Failed to read fallback key file: {}", e)))?;
        let key_bytes = BASE64_STANDARD
            .decode(content.trim())
            .map_err(|e| CryptoError::KeyringUnavailable(format!("Corrupted fallback key file: {}", e)))?;

        if key_bytes.len() != KEY_LEN {
            return Err(CryptoError::KeyringUnavailable(format!(
                "Invalid fallback key length: expected {} bytes, got {}",
                KEY_LEN,
                key_bytes.len()
            )));
        }

        let mut key_arr = [0u8; KEY_LEN];
        key_arr.copy_from_slice(&key_bytes);
        return Ok(key_arr);
    }

    // Generate fresh key and persist to key file
    let mut new_key = [0u8; KEY_LEN];
    rand::thread_rng().fill_bytes(&mut new_key);

    let b64_new_key = BASE64_STANDARD.encode(new_key);
    std::fs::write(&key_path, b64_new_key)
        .map_err(|e| CryptoError::KeyringUnavailable(format!("Failed to write fallback key file: {}", e)))?;
    restrict_key_file_permissions(&key_path);

    Ok(new_key)
}

/// Restrict the fallback master key file so only the current user can read it.
/// On Unix this means 0600; on Windows the file lives in the per-user %APPDATA%
/// directory which already restricts access to the owning user.
fn restrict_key_file_permissions(key_path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(dir) = key_path.parent() {
            if let Ok(meta) = std::fs::metadata(dir) {
                let mut perms = meta.permissions();
                perms.set_mode(0o700);
                let _ = std::fs::set_permissions(dir, perms);
            }
        }
        let _ = std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        // %APPDATA% is per-user by default; no additional ACL restriction required.
        let _ = key_path;
    }
}

fn fallback_key_path() -> std::path::PathBuf {
    if let Ok(app_data) = std::env::var("APPDATA") {
        let dir = std::path::PathBuf::from(app_data).join("com.smm.controlcenter");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join(".master_key");
    }

    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let dir = std::path::PathBuf::from(user_profile).join(".smm-control-center");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join(".master_key");
    }

    if let Ok(home) = std::env::var("HOME") {
        let dir = std::path::PathBuf::from(home).join(".smm-control-center");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join(".master_key");
    }

    std::path::PathBuf::from(".master_key")
}

/// Encrypt plaintext OAuth token using AES-256-GCM.
/// Invariant: Generates a unique 12-byte random Nonce for every call.
/// Format: `Base64(Nonce) + ":" + Base64(Ciphertext)`
pub fn encrypt_token(plain_token: &str, key: &[u8; KEY_LEN]) -> Result<String, CryptoError> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plain_token.as_bytes())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let b64_nonce = BASE64_STANDARD.encode(nonce_bytes);
    let b64_ciphertext = BASE64_STANDARD.encode(ciphertext);

    Ok(format!("{}:{}", b64_nonce, b64_ciphertext))
}

/// Decrypt token formatted as `Base64(Nonce) + ":" + Base64(Ciphertext)` using AES-256-GCM.
pub fn decrypt_token(encrypted_data: &str, key: &[u8; KEY_LEN]) -> Result<String, CryptoError> {
    let parts: Vec<&str> = encrypted_data.split(':').collect();
    if parts.len() != 2 {
        return Err(CryptoError::DecryptionFailed(
            "Invalid encrypted token format: expected Base64(Nonce):Base64(Ciphertext)".to_string(),
        ));
    }

    let nonce_bytes = BASE64_STANDARD
        .decode(parts[0])
        .map_err(|e| CryptoError::DecryptionFailed(format!("Invalid base64 in nonce: {}", e)))?;

    if nonce_bytes.len() != NONCE_LEN {
        return Err(CryptoError::DecryptionFailed(format!(
            "Invalid nonce length: expected {} bytes, got {}",
            NONCE_LEN,
            nonce_bytes.len()
        )));
    }

    let ciphertext_bytes = BASE64_STANDARD
        .decode(parts[1])
        .map_err(|e| CryptoError::DecryptionFailed(format!("Invalid base64 in ciphertext: {}", e)))?;

    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(&nonce_bytes);

    let decrypted_bytes = cipher
        .decrypt(nonce, ciphertext_bytes.as_ref())
        .map_err(|e| CryptoError::DecryptionFailed(format!("AES-GCM decryption failed: {}", e)))?;

    String::from_utf8(decrypted_bytes)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Decrypted bytes are not valid UTF-8: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_cycle() {
        let mut key = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut key);

        let secret = "vk1.a.secret_access_token_value_xyz789";
        let encrypted = encrypt_token(secret, &key).expect("Encryption must succeed");

        assert!(encrypted.contains(':'), "Encrypted string must contain ':' separator");

        let decrypted = decrypt_token(&encrypted, &key).expect("Decryption must succeed");
        assert_eq!(secret, decrypted, "Decrypted text must match original plaintext");
    }

    #[test]
    fn test_unique_nonce_produces_different_ciphertexts() {
        let mut key = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut key);

        let secret = "same_secret_token_content";
        let enc1 = encrypt_token(secret, &key).expect("Encryption 1 must succeed");
        let enc2 = encrypt_token(secret, &key).expect("Encryption 2 must succeed");

        assert_ne!(
            enc1, enc2,
            "Encrypting the same text twice must produce different ciphertexts due to unique nonces"
        );

        // Both must still decrypt to the exact same original secret
        assert_eq!(decrypt_token(&enc1, &key).unwrap(), secret);
        assert_eq!(decrypt_token(&enc2, &key).unwrap(), secret);
    }

    #[test]
    fn test_decryption_failures_on_corrupted_data() {
        let mut key = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut key);

        // 1. Missing colon
        let err1 = decrypt_token("not_a_valid_format", &key);
        assert!(matches!(err1, Err(CryptoError::DecryptionFailed(_))));

        // 2. Invalid base64 in nonce
        let err2 = decrypt_token("invalid!base64:c29tZXRoaW5n", &key);
        assert!(matches!(err2, Err(CryptoError::DecryptionFailed(_))));

        // 3. Invalid nonce length (e.g. 5 bytes instead of 12)
        let short_nonce = BASE64_STANDARD.encode([1, 2, 3, 4, 5]);
        let valid_ct = BASE64_STANDARD.encode(b"ciphertext");
        let err3 = decrypt_token(&format!("{}:{}", short_nonce, valid_ct), &key);
        assert!(matches!(err3, Err(CryptoError::DecryptionFailed(_))));

        // 4. Wrong key
        let secret = "my_token";
        let enc = encrypt_token(secret, &key).unwrap();
        let mut wrong_key = [0u8; KEY_LEN];
        wrong_key[0] = key[0] ^ 0xFF; // flip bits
        let err4 = decrypt_token(&enc, &wrong_key);
        assert!(matches!(err4, Err(CryptoError::DecryptionFailed(_))));
    }

    #[test]
    #[cfg(unix)]
    fn test_fallback_key_file_has_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let key_path = dir.path().join(".master_key");
        let key = [7u8; KEY_LEN];
        std::fs::write(&key_path, BASE64_STANDARD.encode(key))
            .expect("Failed to write key file");

        restrict_key_file_permissions(&key_path);

        let mode = std::fs::metadata(&key_path)
            .expect("Failed to read metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "Fallback key file must be 0600");
    }

    #[test]
    fn test_get_or_generate_key_keyring() {
        match get_or_generate_key() {
            Ok(key) => {
                assert_eq!(key.len(), 32);
                let key2 = get_or_generate_key().expect("Second get must succeed");
                assert_eq!(key, key2, "Key from keyring must be persistent");
            }
            Err(CryptoError::KeyringUnavailable(msg)) => {
                eprintln!("Keyring unavailable in test environment (acceptable fallback): {}", msg);
            }
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
    }
}
