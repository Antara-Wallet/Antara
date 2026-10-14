//! The legacy native WebAuthn bridge currently supports Windows only.
//! Privy authentication uses its own frontend provider, not these commands.

use serde_json::Value;

#[tauri::command]
pub fn webauthn_make_credential(options: Value, origin: String) -> Result<Value, String> {
    let _ = (options, origin);
    Err("The legacy native WebAuthn bridge is currently supported only on Windows.".into())
}

#[tauri::command]
pub fn webauthn_get_assertion(options: Value, origin: String) -> Result<Value, String> {
    let _ = (options, origin);
    Err("The legacy native WebAuthn bridge is currently supported only on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_webauthn_never_returns_credentials() {
        let options = serde_json::json!({ "challenge": "example" });
        let origin = "http://localhost:1420".to_string();
        assert!(webauthn_make_credential(options.clone(), origin.clone()).is_err());
        assert!(webauthn_get_assertion(options, origin).is_err());
    }
}
