//! Embedded multi-tab browser. Each tab is its own child webview of the main
//! window ("ark-browser-<id>"), floated over the Browser tab region; only the
//! active tab's webview is shown, the rest are hidden.
//!
//! Windows note: webview ops (esp. `add_child`) DEADLOCK from a SYNC command
//! (sync commands run on the main thread). Every command here is `async`.
//!
//! Child webviews have no IPC capabilities. Navigation is additionally limited
//! to public HTTP(S) hostnames; this is not a DNS or subresource firewall.

use serde::Serialize;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window};

const PREFIX: &str = "ark-browser-";

fn label(id: &str) -> String {
    format!("{PREFIX}{id}")
}

#[derive(Serialize, Clone)]
struct NavEvent {
    id: String,
    url: String,
}

fn parse_url(s: &str) -> Result<Url, String> {
    let s = s.trim();
    if s.is_empty() || s.chars().any(|c| c.is_control() || c == '\\') {
        return Err("Enter a public HTTP(S) website address.".into());
    }
    let normalized = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let url = Url::parse(&normalized).map_err(|_| "Invalid website address.".to_string())?;
    validate_navigation(&url)?;
    Ok(url)
}

/// Check the canonical URL on initial loads and every redirect/navigation.
/// IP literals (including nonstandard IPv4 encodings) are deliberately excluded.
/// DNS resolution happens in WebView2, so this does not prevent DNS rebinding or
/// page subresource requests to a private IP. IPC isolation is enforced by ACLs.
fn validate_navigation(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only HTTP(S) websites can be opened in the browser.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Website addresses containing credentials are not allowed.".into());
    }
    let host = url
        .domain()
        .ok_or("Use a public website hostname, not an IP address.")?;
    let host = host.strip_suffix('.').unwrap_or(host);
    if !host.contains('.')
        || host.split('.').any(|part| {
            part.is_empty()
                || part.len() > 63
                || part.starts_with('-')
                || part.ends_with('-')
                || !part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
    {
        return Err("Local and invalid hostnames are not allowed.".into());
    }
    const LOCAL_SUFFIXES: &[&str] = &[
        "localhost",
        "local",
        "localdomain",
        "internal",
        "intranet",
        "lan",
        "home",
        "corp",
        "home.arpa",
        "in-addr.arpa",
        "ip6.arpa",
        "test",
        "invalid",
        "example",
    ];
    if LOCAL_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err("Local and private-network websites are not allowed.".into());
    }
    Ok(())
}

fn main_window(app: &AppHandle) -> Result<Window, String> {
    app.get_window("main")
        .ok_or_else(|| "no main window".into())
}

/// Hide every browser tab webview except `keep`, then position + show `keep`.
fn activate_impl(app: &AppHandle, keep: &str, x: f64, y: f64, width: f64, height: f64) {
    let keep_label = label(keep);
    for (lbl, wv) in app.webviews() {
        if lbl.starts_with(PREFIX) && lbl != keep_label {
            let _ = wv.hide();
        }
    }
    if let Some(wv) = app.get_webview(&keep_label) {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width, height));
        let _ = wv.show();
    }
}

/// Open a tab: create its webview (navigating to `url`) if missing, then make it
/// the visible/active tab at the given region.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let lbl = label(&id);
    if app.get_webview(&lbl).is_none() {
        let parsed = parse_url(&url)?;
        let window = main_window(&app)?;
        let app_handle = app.clone();
        let ev_id = id.clone();
        let builder = WebviewBuilder::new(&lbl, WebviewUrl::External(parsed))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_navigation(move |u| {
                if validate_navigation(u).is_err() {
                    return false;
                }
                let _ = app_handle.emit_to(
                    "main",
                    "browser:navigated",
                    NavEvent {
                        id: ev_id.clone(),
                        url: u.to_string(),
                    },
                );
                true
            });
        window
            .add_child(
                builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(width, height),
            )
            .map_err(|e| e.to_string())?;
    }
    activate_impl(&app, &id, x, y, width, height);
    Ok(())
}

/// Make `id` the visible tab at the given region (hides the others).
#[tauri::command]
pub async fn browser_activate(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    activate_impl(&app, &id, x, y, width, height);
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    let wv = app.get_webview(&label(&id)).ok_or("tab not open")?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(&id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide all browser tabs (e.g. when leaving the Browser screen).
#[tauri::command]
pub async fn browser_hide_all(app: AppHandle) -> Result<(), String> {
    for (lbl, wv) in app.webviews() {
        if lbl.starts_with(PREFIX) {
            let _ = wv.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, id: String) -> Result<(), String> {
    let wv = app.get_webview(&label(&id)).ok_or("tab not open")?;
    wv.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, id: String) -> Result<(), String> {
    let wv = app.get_webview(&label(&id)).ok_or("tab not open")?;
    wv.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, id: String) -> Result<(), String> {
    let wv = app.get_webview(&label(&id)).ok_or("tab not open")?;
    wv.eval("location.reload()").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_url, validate_navigation};
    use tauri::Url;

    #[test]
    fn accepts_public_websites_and_normalizes_bare_hostnames() {
        assert_eq!(
            parse_url("  etherscan.io/address/0x1  ").unwrap().as_str(),
            "https://etherscan.io/address/0x1"
        );
        for url in [
            "https://app.uniswap.org/#/swap",
            "http://example.com:8080/path",
            "https://example.com./",
            "https://xn--bcher-kva.de/",
        ] {
            assert!(parse_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn rejects_local_schemes_credentials_and_parser_ambiguities() {
        for url in [
            "",
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///C:/Users/PC/secret",
            "tauri://localhost/",
            "asset://localhost/",
            "ipc://localhost/",
            "about:blank",
            "blob:https://example.com/a",
            "ftp://example.com/",
            "https://user:pass@example.com/",
            "https://example.com@localhost/",
            "https://localhost@example.com/",
            "https://example.com\\@localhost/",
            "https://exam\nple.com/",
        ] {
            assert!(parse_url(url).is_err(), "unexpectedly allowed {url}");
        }
    }

    #[test]
    fn blocks_loopback_private_ip_encodings_and_internal_domains() {
        for url in [
            "http://localhost:1420/",
            "https://tauri.localhost/",
            "https://ipc.localhost/",
            "http://LOCALHOST./",
            "http://127.0.0.1:8787/",
            "http://127.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0177.0.0.1/",
            "http://10.0.0.1/",
            "https://192.168.1.1/",
            "https://172.16.0.1/",
            "http://169.254.169.254/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fe80::1]/",
            "https://[fd00::1]/",
            "https://8.8.8.8/",
            "http://printer/",
            "http://printer.local/",
            "https://wallet.internal/",
            "http://gateway.home.arpa/",
            "https://app.localhost./",
            "https://%6cocalhost/",
        ] {
            assert!(parse_url(url).is_err(), "unexpectedly allowed {url}");
        }
    }

    #[test]
    fn redirect_policy_reuses_the_same_local_origin_rejection() {
        for destination in [
            "https://tauri.localhost/index.html",
            "http://localhost:1420/",
            "file:///C:/secret",
            "http://192.168.0.1/",
        ] {
            assert!(validate_navigation(&Url::parse(destination).unwrap()).is_err());
        }
        assert!(validate_navigation(&Url::parse("https://etherscan.io/tx/0x123").unwrap()).is_ok());
    }

    /// Native commands the main webview may invoke. That webview also hosts the
    /// Privy and WalletConnect frames, so this is the complete grant.
    const MAIN_GRANTED: &[&str] = &[
        "list_usb_devices",
        "vault_exists",
        "create_vault",
        "import_vault",
        "unlock_vault",
        "lock_vault",
        "list_accounts",
        "add_account",
        "stealth_meta_address",
        "stealth_send_compute",
        "stealth_scan",
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
    ];

    /// Registered but granted to no webview: raw-hash (blind) signing, key and
    /// mnemonic reveal, private-key import, native WebAuthn and drive listing.
    const MAIN_DENIED: &[&str] = &[
        "list_drives",
        "import_account",
        "sign_hash",
        "reveal_mnemonic",
        "reveal_private_key",
        "stealth_sign",
        "webauthn_make_credential",
        "webauthn_get_assertion",
    ];

    fn permission_for(command: &str) -> String {
        format!("allow-{}", command.replace('_', "-"))
    }

    #[test]
    fn custom_commands_are_enrolled_and_only_main_webview_receives_capabilities() {
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        let main = &capabilities["default"];
        assert_eq!(main["webviews"], serde_json::json!(["main"]));
        assert!(main
            .get("windows")
            .is_none_or(|windows| windows.as_array().is_some_and(Vec::is_empty)));
        assert!(main.get("remote").is_none_or(serde_json::Value::is_null));
        assert_eq!(
            capabilities.as_object().unwrap().len(),
            1,
            "Review any additional capability for browser access"
        );

        // The exact grant: two plugin defaults plus MAIN_GRANTED, nothing else.
        let mut granted: Vec<&str> = main["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry.as_str().expect("permission identifiers only"))
            .collect();
        let mut expected: Vec<String> = ["core:default", "opener:default"]
            .iter()
            .map(|s| s.to_string())
            .chain(MAIN_GRANTED.iter().map(|name| permission_for(name)))
            .collect();
        granted.sort_unstable();
        expected.sort_unstable();
        assert_eq!(granted, expected, "main capability must match the reviewed grant");
        for name in MAIN_DENIED {
            assert!(
                !granted.contains(&permission_for(name).as_str()),
                "main must not be granted {name}"
            );
        }

        let manifests: serde_json::Value =
            serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
        let permissions = &manifests["__app-acl__"]["permissions"];
        let registered: Vec<&str> = include_str!("lib.rs")
            .split("tauri::generate_handler![")
            .nth(1)
            .unwrap()
            .split("])")
            .next()
            .unwrap()
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|command| command.rsplit("::").next().unwrap())
            .collect();
        assert_eq!(
            registered.len(),
            MAIN_GRANTED.len() + MAIN_DENIED.len(),
            "classify every registered command as granted or denied"
        );
        for name in &registered {
            // Enrolled commands are denied unless a capability grants them.
            assert_eq!(
                permissions[&permission_for(name)]["commands"]["allow"],
                serde_json::json!([name]),
                "{name} missing generated app permission"
            );
            assert!(
                MAIN_GRANTED.contains(name) != MAIN_DENIED.contains(name),
                "{name} must be in exactly one of MAIN_GRANTED or MAIN_DENIED"
            );
        }
    }

    #[test]
    fn runtime_acl_denies_key_reveal_and_blind_signing_to_every_webview() {
        let mut context = crate::app_context();
        let authority = context.runtime_authority_mut();
        let local = tauri::ipc::Origin::Local;
        let remote = tauri::ipc::Origin::Remote {
            url: Url::parse("https://auth.privy.io/").unwrap(),
        };
        for command in MAIN_DENIED {
            for (webview, origin) in [
                ("main", &local),
                ("main", &remote),
                ("ark-browser-test", &local),
                ("ark-browser-test", &remote),
            ] {
                assert!(
                    authority
                        .resolve_access(command, "main", webview, origin)
                        .is_none(),
                    "{webview} gained {command}"
                );
            }
        }
    }

    /// Vault-layer commands (docs/VAULT_LAYERS.md §10): the app's own code
    /// only. The Privy and WalletConnect frames in the main webview are remote
    /// origins and must never reach the native passkey or location commands.
    const LAYER_COMMANDS: &[&str] = &[
        "layer_wifi_connections",
        "layer_bluetooth_connected",
        "layer_location",
        "layer_passkey_get",
        "layer_passkey_create",
        "open_location_settings",
    ];

    #[test]
    fn runtime_acl_grants_layer_commands_to_the_main_local_origin_only() {
        let mut context = crate::app_context();
        let authority = context.runtime_authority_mut();
        let local = tauri::ipc::Origin::Local;
        let privy = tauri::ipc::Origin::Remote {
            url: Url::parse("https://auth.privy.io/").unwrap(),
        };
        let site = tauri::ipc::Origin::Remote {
            url: Url::parse("https://antara.tech/").unwrap(),
        };
        for command in LAYER_COMMANDS {
            assert!(MAIN_GRANTED.contains(command), "{command} must be a reviewed main grant");
            assert!(
                authority.resolve_access(command, "main", "main", &local).is_some(),
                "main lost {command}"
            );
            for (webview, origin) in [
                ("main", &privy),
                ("main", &site),
                ("ark-browser-test", &local),
                ("ark-browser-test", &privy),
            ] {
                assert!(
                    authority
                        .resolve_access(command, "main", webview, origin)
                        .is_none(),
                    "{webview} gained {command}"
                );
            }
        }
        // The legacy bridge, which takes any RP ID and origin from JavaScript,
        // stays denied everywhere.
        for command in ["webauthn_make_credential", "webauthn_get_assertion"] {
            assert!(MAIN_DENIED.contains(&command));
            assert!(authority.resolve_access(command, "main", "main", &local).is_none());
        }
    }

    #[test]
    fn runtime_acl_denies_child_webviews_even_if_they_reach_a_local_origin() {
        let mut context = crate::app_context();
        let authority = context.runtime_authority_mut();
        let local = tauri::ipc::Origin::Local;
        let remote = tauri::ipc::Origin::Remote {
            url: Url::parse("https://example.com/").unwrap(),
        };
        for command in [
            "unlock_vault",
            "list_accounts",
            "stealth_scan",
            "browser_open",
            "plugin:opener|open_url",
        ] {
            assert!(
                authority
                    .resolve_access(command, "main", "main", &local)
                    .is_some(),
                "main lost {command}"
            );
            assert!(
                authority
                    .resolve_access(command, "main", "ark-browser-test", &local)
                    .is_none(),
                "child local origin gained {command}"
            );
            assert!(
                authority
                    .resolve_access(command, "main", "ark-browser-test", &remote)
                    .is_none(),
                "child remote origin gained {command}"
            );
            assert!(
                authority
                    .resolve_access(command, "main", "main", &remote)
                    .is_none(),
                "main remote origin gained {command}"
            );
        }
    }
}
