fn main() {
    // Enrolling app commands switches Tauri from implicit local-origin access
    // to capability checks, including for any untrusted child webview.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_drives",
            "list_usb_devices",
            "vault_exists",
            "create_vault",
            "import_vault",
            "unlock_vault",
            "lock_vault",
            "list_accounts",
            "add_account",
            "import_account",
            "sign_hash",
            "reveal_mnemonic",
            "reveal_private_key",
            "stealth_meta_address",
            "stealth_send_compute",
            "stealth_scan",
            "stealth_sign",
            "webauthn_make_credential",
            "webauthn_get_assertion",
            "list_bluetooth_devices",
            "get_location",
            "layer_wifi_connections",
            "layer_bluetooth_connected",
            "layer_location",
            "layer_passkey_get",
            "layer_passkey_create",
            "open_location_settings",
            "browser_open",
            "browser_activate",
            "browser_navigate",
            "browser_close",
            "browser_hide_all",
            "browser_back",
            "browser_forward",
            "browser_reload",
        ]),
    ))
    .expect("failed to build the native command access policy");
}
