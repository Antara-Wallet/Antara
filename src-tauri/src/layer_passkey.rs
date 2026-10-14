//! Native passkey ceremonies for the Biometrics vault layer
//! (docs/VAULT_LAYERS.md §6.2 and §10).
//!
//! WebAuthn inside WebView2 does not reliably show Windows Hello, so ANTARA
//! Desktop calls Windows' webauthn.dll directly. Unlike the legacy
//! `webauthn_*` bridge (registered but granted to no webview), these commands:
//! - run only for the "main" webview while its page is on the app's own local
//!   origin (`authorize`, checked first, on top of the capability grant);
//! - accept only a relying-party ID from a compiled allowlist (`antara.tech`;
//!   debug builds add `localhost`), so JavaScript cannot pick another site;
//! - fix the signed clientDataJSON origin to `https://tauri.localhost`;
//! - always require user verification (Windows Hello, a security-key PIN, or a
//!   phone through the "use a phone" dialog), with any authenticator attachment;
//! - validate every size and range, and return only the
//!   AuthenticationResponseJSON / RegistrationResponseJSON fields.
//!
//! ANTARA's server verifies the result (signature, RP ID hash, origin, UV flag,
//! challenge and counter); nothing here is trusted on its own. The signed
//! origin proves nothing about which program asked: webauthn.dll accepts any
//! relying-party ID and clientDataJSON from any local process, so the passkey
//! binds the user's verification to the exact challenge, not to ANTARA's
//! binary (docs/VAULT_LAYERS.md §3). Every error
//! string is exactly one of the codes below. Other platforms return
//! `unsupported-platform`.
#![cfg_attr(not(windows), allow(dead_code))]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Url, Webview};

#[cfg(windows)]
#[path = "layer_passkey_windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "layer_passkey_unavailable.rs"]
mod platform;
// The stub is also compiled into Windows test builds so its refusal is tested.
#[cfg(all(test, windows))]
#[path = "layer_passkey_unavailable.rs"]
mod unavailable;

pub const UNSUPPORTED_PLATFORM: &str = "unsupported-platform";
pub const INVALID_REQUEST: &str = "invalid-request";
pub const PASSKEY_CANCELLED: &str = "passkey-cancelled";
pub const PASSKEY_FAILED: &str = "passkey-failed";

/// The only origin these ceremonies ever sign: the packaged app's own origin.
/// Every Tauri app on Windows shares it, so it does not identify ANTARA.
pub const LAYER_ORIGIN: &str = "https://tauri.localhost";
/// The development server (`build.devUrl` in tauri.conf.json); debug builds only.
pub const DEV_ORIGIN: &str = "http://localhost:1420";
/// The only webview that may open a passkey dialog (the app's own UI).
pub const MAIN_WEBVIEW: &str = "main";
/// The relying party every surface shares (docs/VAULT_LAYERS.md §1).
pub const PRODUCTION_RP_ID: &str = "antara.tech";
/// Debug builds also accept the local development relying party.
pub const DEVELOPMENT_RP_ID: &str = "localhost";

const CHALLENGE_BYTES: usize = 32;
const MIN_CREDENTIAL_ID_BYTES: usize = 16;
const MAX_CREDENTIAL_ID_BYTES: usize = 1023;
const MAX_LISTED_CREDENTIALS: usize = 16;
const MIN_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 180_000;
const MAX_USER_ID_BYTES: usize = 64;
const MAX_DISPLAY_CHARS: usize = 128;
/// rpIdHash (32) + flags (1) + signature counter (4).
const MIN_AUTHENTICATOR_DATA_BYTES: usize = 37;
const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;

/// COSE algorithms offered at registration: ES256 and RS256 only.
pub const COSE_ES256: i32 = -7;
pub const COSE_RS256: i32 = -257;

/// The relying-party IDs this build will use. Compiled in, never from JavaScript.
pub fn allowed_rp_ids() -> &'static [&'static str] {
    if cfg!(debug_assertions) {
        &[PRODUCTION_RP_ID, DEVELOPMENT_RP_ID]
    } else {
        &[PRODUCTION_RP_ID]
    }
}

// ---------------------------------------------------------------------------
// Requests (from JavaScript) and their validated forms.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasskeyGetRequest {
    pub rp_id: String,
    pub challenge: String,
    pub allow_credentials: Vec<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasskeyCreateRequest {
    pub rp_id: String,
    pub rp_name: String,
    pub challenge: String,
    pub user_id: String,
    pub user_name: String,
    pub user_display_name: String,
    pub exclude_credentials: Vec<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidGetRequest {
    /// Always one of `allowed_rp_ids()`, never the caller's string.
    pub rp_id: &'static str,
    pub challenge: [u8; CHALLENGE_BYTES],
    pub allow_credentials: Vec<Vec<u8>>,
    pub timeout_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidCreateRequest {
    pub rp_id: &'static str,
    pub rp_name: String,
    pub challenge: [u8; CHALLENGE_BYTES],
    pub user_id: Vec<u8>,
    pub user_name: String,
    pub user_display_name: String,
    pub exclude_credentials: Vec<Vec<u8>>,
    pub timeout_ms: u32,
}

/// Origins the calling webview's page may be on. Compiled in: the packaged
/// app's origin, plus the development server in debug builds.
pub fn allowed_caller_origins() -> &'static [&'static str] {
    if cfg!(debug_assertions) {
        &[LAYER_ORIGIN, DEV_ORIGIN]
    } else {
        &[LAYER_ORIGIN]
    }
}

/// Defense in depth: the capability already grants these commands to the
/// "main" webview's local origin only (src-tauri/capabilities/default.json and
/// the runtime ACL tests in browser.rs). Refusing any other caller here keeps a
/// future capability mistake from reaching a browser child webview.
pub fn require_main_webview(label: &str) -> Result<(), &'static str> {
    if label == MAIN_WEBVIEW {
        Ok(())
    } else {
        Err(INVALID_REQUEST)
    }
}

/// The first check in both passkey commands, before any validation, window
/// lookup or dialog: the caller is the "main" webview and its current page is
/// on the app's own local origin (`allowed_caller_origins`). An unreadable URL
/// is refused. This does not prove which program asked Windows for a passkey:
/// webauthn.dll serves any local process (docs/VAULT_LAYERS.md §3).
pub fn authorize(label: &str, url: Option<&Url>) -> Result<(), &'static str> {
    require_main_webview(label)?;
    let origin = url
        .map(|url| url.origin().ascii_serialization())
        .ok_or(INVALID_REQUEST)?;
    if allowed_caller_origins().contains(&origin.as_str()) {
        Ok(())
    } else {
        Err(INVALID_REQUEST)
    }
}

/// The checks shared by both ceremonies: the RP ID is in the compiled
/// allowlist (exact match), the challenge is canonical base64url of exactly
/// 32 bytes, and the timeout is 30 to 180 seconds.
pub fn validate_passkey_request(
    rp_id: &str,
    challenge: &str,
    timeout_ms: u64,
) -> Result<(&'static str, [u8; CHALLENGE_BYTES], u32), &'static str> {
    let rp_id = allowed_rp_ids()
        .iter()
        .copied()
        .find(|allowed| *allowed == rp_id)
        .ok_or(INVALID_REQUEST)?;
    let challenge: [u8; CHALLENGE_BYTES] = decode_b64url(challenge)?
        .try_into()
        .map_err(|_| INVALID_REQUEST)?;
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(INVALID_REQUEST);
    }
    Ok((rp_id, challenge, timeout_ms as u32))
}

pub fn validate_get_request(request: &PasskeyGetRequest) -> Result<ValidGetRequest, &'static str> {
    let (rp_id, challenge, timeout_ms) =
        validate_passkey_request(&request.rp_id, &request.challenge, request.timeout_ms)?;
    Ok(ValidGetRequest {
        rp_id,
        challenge,
        allow_credentials: credential_ids(&request.allow_credentials, 1)?,
        timeout_ms,
    })
}

pub fn validate_create_request(
    request: &PasskeyCreateRequest,
) -> Result<ValidCreateRequest, &'static str> {
    let (rp_id, challenge, timeout_ms) =
        validate_passkey_request(&request.rp_id, &request.challenge, request.timeout_ms)?;
    let user_id = decode_b64url(&request.user_id)?;
    if user_id.is_empty() || user_id.len() > MAX_USER_ID_BYTES {
        return Err(INVALID_REQUEST);
    }
    Ok(ValidCreateRequest {
        rp_id,
        rp_name: display_text(&request.rp_name)?,
        challenge,
        user_id,
        user_name: display_text(&request.user_name)?,
        user_display_name: display_text(&request.user_display_name)?,
        // The first passkey for a vault has nothing to exclude.
        exclude_credentials: credential_ids(&request.exclude_credentials, 0)?,
        timeout_ms,
    })
}

/// Parses the raw `request` argument; any shape problem is `invalid-request`.
pub fn parse_get_request(request: Option<Value>) -> Result<ValidGetRequest, &'static str> {
    let request: PasskeyGetRequest = request
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or(INVALID_REQUEST)?;
    validate_get_request(&request)
}

pub fn parse_create_request(request: Option<Value>) -> Result<ValidCreateRequest, &'static str> {
    let request: PasskeyCreateRequest = request
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or(INVALID_REQUEST)?;
    validate_create_request(&request)
}

/// Strict base64url without padding (the base64 engine also refuses
/// non-canonical trailing bits and whitespace).
fn decode_b64url(value: &str) -> Result<Vec<u8>, &'static str> {
    URL_SAFE_NO_PAD.decode(value).map_err(|_| INVALID_REQUEST)
}

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `min..=16` credential IDs, each 16 to 1023 bytes.
fn credential_ids(ids: &[String], min: usize) -> Result<Vec<Vec<u8>>, &'static str> {
    if ids.len() < min || ids.len() > MAX_LISTED_CREDENTIALS {
        return Err(INVALID_REQUEST);
    }
    ids.iter()
        .map(|id| {
            let bytes = decode_b64url(id)?;
            if (MIN_CREDENTIAL_ID_BYTES..=MAX_CREDENTIAL_ID_BYTES).contains(&bytes.len()) {
                Ok(bytes)
            } else {
                Err(INVALID_REQUEST)
            }
        })
        .collect()
}

/// Names shown in the OS dialog: 1 to 128 characters, no control characters.
fn display_text(value: &str) -> Result<String, &'static str> {
    let count = value.chars().count();
    if value.trim().is_empty() || count > MAX_DISPLAY_CHARS || value.chars().any(char::is_control) {
        return Err(INVALID_REQUEST);
    }
    Ok(value.to_string())
}

// ---------------------------------------------------------------------------
// clientDataJSON, error mapping and responses.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ceremony {
    Get,
    Create,
}

impl Ceremony {
    fn client_data_type(self) -> &'static str {
        match self {
            Ceremony::Get => "webauthn.get",
            Ceremony::Create => "webauthn.create",
        }
    }
}

/// Field order is fixed by the struct (type, challenge, origin, crossOrigin),
/// as WebAuthn's serialization requires; serde_json escapes every value.
#[derive(Serialize)]
struct ClientData<'a> {
    #[serde(rename = "type")]
    ceremony: &'a str,
    challenge: &'a str,
    origin: &'a str,
    #[serde(rename = "crossOrigin")]
    cross_origin: bool,
}

/// The clientDataJSON the authenticator signs. The origin is always
/// `https://tauri.localhost`; the caller cannot change it.
pub fn client_data_json(ceremony: Ceremony, challenge_b64url: &str) -> String {
    serde_json::to_string(&ClientData {
        ceremony: ceremony.client_data_type(),
        challenge: challenge_b64url,
        origin: LAYER_ORIGIN,
        cross_origin: false,
    })
    .expect("clientDataJSON holds only strings and a bool")
}

/// Maps the W3C DOM error name Windows reports for a failed ceremony.
/// `NotAllowedError` covers a cancel, a timeout or no matching credential,
/// exactly as in a browser.
pub fn map_webauthn_error(dom_error_name: &str) -> &'static str {
    if dom_error_name == "NotAllowedError" {
        PASSKEY_CANCELLED
    } else {
        PASSKEY_FAILED
    }
}

/// WebAuthn transport names for webauthn.dll's `WEBAUTHN_CTAP_TRANSPORT_*` flags.
pub fn transports_from_flags(flags: u32) -> Vec<&'static str> {
    [
        (0x01, "usb"),
        (0x02, "nfc"),
        (0x04, "ble"),
        (0x10, "internal"),
        (0x20, "hybrid"),
    ]
    .iter()
    .filter(|(bit, _)| flags & bit != 0)
    .map(|(_, name)| *name)
    .collect()
}

/// What webauthn.dll returned for an assertion (copied out before it is freed).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssertionParts {
    pub credential_id: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub signature: Vec<u8>,
    pub user_handle: Vec<u8>,
}

/// What webauthn.dll returned for a registration (copied out before it is freed).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CredentialParts {
    pub credential_id: Vec<u8>,
    pub attestation_object: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    /// `WEBAUTHN_CTAP_TRANSPORT_*` flags, 0 when Windows did not say.
    pub used_transport: u32,
}

/// `{}` for `clientExtensionResults`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct NoExtensions {}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AssertionResponseBody {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    #[serde(rename = "authenticatorData")]
    pub authenticator_data: String,
    pub signature: String,
    #[serde(rename = "userHandle")]
    pub user_handle: Option<String>,
}

/// AuthenticationResponseJSON, exactly the contract's fields.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AuthenticationResponse {
    pub id: String,
    #[serde(rename = "rawId")]
    pub raw_id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub response: AssertionResponseBody,
    #[serde(rename = "clientExtensionResults")]
    pub client_extension_results: NoExtensions,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AttestationResponseBody {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    #[serde(rename = "attestationObject")]
    pub attestation_object: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub transports: Vec<&'static str>,
}

/// RegistrationResponseJSON, exactly the contract's fields.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RegistrationResponse {
    pub id: String,
    #[serde(rename = "rawId")]
    pub raw_id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub response: AttestationResponseBody,
    #[serde(rename = "clientExtensionResults")]
    pub client_extension_results: NoExtensions,
}

/// The authenticator data must be complete and carry both the UP and UV
/// flags. The server checks this too; refusing here keeps an unverified result
/// off the wire.
fn user_verified(authenticator_data: &[u8]) -> bool {
    const REQUIRED: u8 = FLAG_USER_PRESENT | FLAG_USER_VERIFIED;
    authenticator_data.len() >= MIN_AUTHENTICATOR_DATA_BYTES
        && authenticator_data[32] & REQUIRED == REQUIRED
}

fn usable_credential_id(id: &[u8]) -> bool {
    (MIN_CREDENTIAL_ID_BYTES..=MAX_CREDENTIAL_ID_BYTES).contains(&id.len())
}

/// Builds AuthenticationResponseJSON. The credential must be one the request
/// allowed (Windows enforces this too; the server checks it again).
pub fn assertion_response(
    parts: &AssertionParts,
    client_data: &[u8],
    allowed: &[Vec<u8>],
) -> Result<AuthenticationResponse, &'static str> {
    if !usable_credential_id(&parts.credential_id)
        || !allowed.contains(&parts.credential_id)
        || !user_verified(&parts.authenticator_data)
        || parts.signature.is_empty()
        || client_data.is_empty()
    {
        return Err(PASSKEY_FAILED);
    }
    let id = b64url(&parts.credential_id);
    Ok(AuthenticationResponse {
        raw_id: id.clone(),
        id,
        kind: "public-key",
        response: AssertionResponseBody {
            client_data_json: b64url(client_data),
            authenticator_data: b64url(&parts.authenticator_data),
            signature: b64url(&parts.signature),
            user_handle: (!parts.user_handle.is_empty()).then(|| b64url(&parts.user_handle)),
        },
        client_extension_results: NoExtensions {},
    })
}

/// Builds RegistrationResponseJSON. A new credential is never one the
/// request excluded (Windows enforces this too; the server checks it again).
pub fn registration_response(
    parts: &CredentialParts,
    client_data: &[u8],
    excluded: &[Vec<u8>],
) -> Result<RegistrationResponse, &'static str> {
    if !usable_credential_id(&parts.credential_id)
        || excluded.contains(&parts.credential_id)
        || parts.attestation_object.is_empty()
        || !user_verified(&parts.authenticator_data)
        || client_data.is_empty()
    {
        return Err(PASSKEY_FAILED);
    }
    let id = b64url(&parts.credential_id);
    Ok(RegistrationResponse {
        raw_id: id.clone(),
        id,
        kind: "public-key",
        response: AttestationResponseBody {
            client_data_json: b64url(client_data),
            attestation_object: b64url(&parts.attestation_object),
            transports: transports_from_flags(parts.used_transport),
        },
        client_extension_results: NoExtensions {},
    })
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/// One OS passkey dialog at a time; a second request is refused, not queued.
static CEREMONY_ACTIVE: AtomicBool = AtomicBool::new(false);

struct CeremonyGuard;

impl CeremonyGuard {
    fn acquire() -> Result<Self, &'static str> {
        CEREMONY_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| CeremonyGuard)
            .map_err(|_| PASSKEY_FAILED)
    }
}

impl Drop for CeremonyGuard {
    fn drop(&mut self) {
        CEREMONY_ACTIVE.store(false, Ordering::Release);
    }
}

/// `request: {rpId, challenge, allowCredentials: string[], timeoutMs}` →
/// AuthenticationResponseJSON.
#[tauri::command]
pub async fn layer_passkey_get(
    app: AppHandle,
    webview: Webview,
    request: Option<Value>,
) -> Result<AuthenticationResponse, String> {
    let url = webview.url().ok();
    passkey_get(
        webview.label(),
        url.as_ref(),
        || platform::parent_window(&app),
        request,
    )
    .await
    .map_err(str::to_string)
}

/// `request: {rpId, rpName, challenge, userId, userName, userDisplayName,
/// excludeCredentials: string[], timeoutMs}` → RegistrationResponseJSON.
#[tauri::command]
pub async fn layer_passkey_create(
    app: AppHandle,
    webview: Webview,
    request: Option<Value>,
) -> Result<RegistrationResponse, String> {
    let url = webview.url().ok();
    passkey_create(
        webview.label(),
        url.as_ref(),
        || platform::parent_window(&app),
        request,
    )
    .await
    .map_err(str::to_string)
}

/// The ceremony after the command wrapper: `authorize` first, then platform
/// support, request validation, the parent window (`parent_window`, which a
/// dialog needs) and only then the dialog. Unit tests drive this order with a
/// `parent_window` that never yields a window, so no test can open a dialog.
async fn passkey_get(
    webview_label: &str,
    webview_url: Option<&Url>,
    parent_window: impl FnOnce() -> Result<isize, &'static str>,
    request: Option<Value>,
) -> Result<AuthenticationResponse, &'static str> {
    authorize(webview_label, webview_url)?;
    if !platform::SUPPORTED {
        return Err(UNSUPPORTED_PLATFORM);
    }
    let request = parse_get_request(request)?;
    let parent = parent_window()?;
    let guard = CeremonyGuard::acquire()?;
    let allowed = request.allow_credentials.clone();
    let client_data = client_data_json(Ceremony::Get, &b64url(&request.challenge)).into_bytes();
    let (parts, client_data) = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        platform::get_assertion(parent, &request, &client_data).map(|parts| (parts, client_data))
    })
    .await
    .unwrap_or(Err(PASSKEY_FAILED))?;
    assertion_response(&parts, &client_data, &allowed)
}

/// As `passkey_get`, for registration.
async fn passkey_create(
    webview_label: &str,
    webview_url: Option<&Url>,
    parent_window: impl FnOnce() -> Result<isize, &'static str>,
    request: Option<Value>,
) -> Result<RegistrationResponse, &'static str> {
    authorize(webview_label, webview_url)?;
    if !platform::SUPPORTED {
        return Err(UNSUPPORTED_PLATFORM);
    }
    let request = parse_create_request(request)?;
    let parent = parent_window()?;
    let guard = CeremonyGuard::acquire()?;
    let excluded = request.exclude_credentials.clone();
    let client_data = client_data_json(Ceremony::Create, &b64url(&request.challenge)).into_bytes();
    let (parts, client_data) = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        platform::make_credential(parent, &request, &client_data).map(|parts| (parts, client_data))
    })
    .await
    .unwrap_or(Err(PASSKEY_FAILED))?;
    registration_response(&parts, &client_data, &excluded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b64(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn challenge() -> String {
        b64(&[7u8; 32])
    }

    fn credential(seed: u8) -> String {
        b64(&[seed; 32])
    }

    fn get_request() -> Value {
        json!({ "rpId": "antara.tech", "challenge": challenge(), "allowCredentials": [credential(1)], "timeoutMs": 120_000 })
    }

    fn create_request() -> Value {
        json!({
            "rpId": "antara.tech",
            "rpName": "ANTARA",
            "challenge": challenge(),
            "userId": b64(&[9u8; 32]),
            "userName": "ANTARA vault 7xKXtg…sgAs",
            "userDisplayName": "ANTARA vault 7xKXtg…sgAs",
            "excludeCredentials": [],
            "timeoutMs": 120_000,
        })
    }

    fn with(mut value: Value, key: &str, replacement: Value) -> Value {
        value[key] = replacement;
        value
    }

    #[test]
    fn rp_ids_come_from_the_compiled_allowlist() {
        assert!(allowed_rp_ids().contains(&"antara.tech"));
        assert_eq!(
            allowed_rp_ids().contains(&"localhost"),
            cfg!(debug_assertions)
        );
        assert!(!allowed_rp_ids().contains(&"tauri.localhost"));
        let valid = parse_get_request(Some(get_request())).unwrap();
        assert_eq!(valid.rp_id, PRODUCTION_RP_ID);
        assert_eq!(valid.challenge, [7u8; 32]);
        assert_eq!(valid.allow_credentials, vec![vec![1u8; 32]]);
        assert_eq!(valid.timeout_ms, 120_000);
    }

    #[test]
    fn only_the_main_webview_may_open_a_passkey_dialog() {
        assert_eq!(require_main_webview("main"), Ok(()));
        for label in [
            "ark-browser-1",
            "ark-browser-test",
            "",
            "Main",
            "main ",
            "mainx",
        ] {
            assert_eq!(require_main_webview(label), Err(INVALID_REQUEST), "{label}");
        }
    }

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn authorize_requires_the_main_webview_on_the_apps_own_origin() {
        let app = url("https://tauri.localhost/index.html#vault");
        assert_eq!(authorize("main", Some(&app)), Ok(()));
        assert_eq!(
            authorize("main", Some(&url("https://tauri.localhost"))),
            Ok(())
        );
        assert_eq!(
            authorize("main", Some(&url("https://TAURI.localhost:443/"))),
            Ok(())
        );
        assert_eq!(
            authorize("main", Some(&url("http://localhost:1420/#vault"))).is_ok(),
            cfg!(debug_assertions),
            "the development server is accepted in debug builds only"
        );
        for label in ["ark-browser-1", "ark-browser-test", "", "Main", "main "] {
            assert_eq!(
                authorize(label, Some(&app)),
                Err(INVALID_REQUEST),
                "{label}"
            );
        }
        // An unreadable URL is refused.
        assert_eq!(authorize("main", None), Err(INVALID_REQUEST));
        for page in [
            "http://tauri.localhost/",
            "https://tauri.localhost:8443/",
            "https://tauri.localhost.evil.example/",
            "https://evil.tauri.localhost/",
            "https://auth.privy.io/",
            "https://antara.tech/",
            "tauri://localhost/",
            "about:blank",
            "data:text/html,x",
            "http://localhost:1421/",
            "http://127.0.0.1:1420/",
            "https://localhost:1420/",
        ] {
            assert_eq!(
                authorize("main", Some(&url(page))),
                Err(INVALID_REQUEST),
                "{page}"
            );
        }
    }

    #[test]
    fn the_dev_origin_is_the_configured_dev_url() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let dev = url(conf["build"]["devUrl"].as_str().unwrap());
        assert_eq!(dev.origin().ascii_serialization(), DEV_ORIGIN);
    }

    /// A `parent_window` for the wiring tests: records that it was reached
    /// and never yields a window, so no test can open a passkey dialog.
    fn no_window(reached: &AtomicBool) -> impl FnOnce() -> Result<isize, &'static str> + '_ {
        move || {
            reached.store(true, Ordering::SeqCst);
            Err(PASSKEY_FAILED)
        }
    }

    #[test]
    fn commands_refuse_an_unauthorized_caller_before_anything_else() {
        use tauri::async_runtime::block_on as block;
        let app = url("https://tauri.localhost/");
        let site = url("https://example.com/");
        for (label, page) in [
            ("ark-browser-1", Some(&app)),
            ("ark-browser-1", Some(&site)),
            ("main", Some(&site)),
            ("main", None),
        ] {
            let reached = AtomicBool::new(false);
            let get = block(passkey_get(
                label,
                page,
                no_window(&reached),
                Some(get_request()),
            ));
            assert_eq!(get.map(|_| ()), Err(INVALID_REQUEST), "{label} {page:?}");
            let create = block(passkey_create(
                label,
                page,
                no_window(&reached),
                Some(create_request()),
            ));
            assert_eq!(create.map(|_| ()), Err(INVALID_REQUEST), "{label} {page:?}");
            assert!(
                !reached.load(Ordering::SeqCst),
                "{label} reached the window lookup"
            );
        }

        // Authorized, but malformed: refused before the window lookup.
        let malformed = if platform::SUPPORTED {
            INVALID_REQUEST
        } else {
            UNSUPPORTED_PLATFORM
        };
        let reached = AtomicBool::new(false);
        let get = block(passkey_get(
            "main",
            Some(&app),
            no_window(&reached),
            Some(json!({})),
        ));
        assert_eq!(get.map(|_| ()), Err(malformed));
        let create = block(passkey_create(
            "main",
            Some(&app),
            no_window(&reached),
            None,
        ));
        assert_eq!(create.map(|_| ()), Err(malformed));
        assert!(!reached.load(Ordering::SeqCst));

        // Authorized and valid: reaches the window lookup, the last step before
        // a dialog (Windows only; other platforms stop as unsupported).
        for create in [false, true] {
            let reached = AtomicBool::new(false);
            let outcome = if create {
                block(passkey_create(
                    "main",
                    Some(&app),
                    no_window(&reached),
                    Some(create_request()),
                ))
                .map(|_| ())
            } else {
                block(passkey_get(
                    "main",
                    Some(&app),
                    no_window(&reached),
                    Some(get_request()),
                ))
                .map(|_| ())
            };
            if platform::SUPPORTED {
                assert_eq!(outcome, Err(PASSKEY_FAILED));
                assert!(reached.load(Ordering::SeqCst));
            } else {
                assert_eq!(outcome, Err(UNSUPPORTED_PLATFORM));
                assert!(!reached.load(Ordering::SeqCst));
            }
        }
    }

    #[test]
    fn passkey_get_validation_refuses_every_out_of_range_field() {
        for rp_id in [
            "example.com",
            "",
            "ANTARA.TECH",
            "antara.tech.",
            "evil.antara.tech",
            "tauri.localhost",
            " antara.tech",
        ] {
            assert_eq!(
                parse_get_request(Some(with(get_request(), "rpId", json!(rp_id)))),
                Err(INVALID_REQUEST),
                "{rp_id}"
            );
        }
        for bad in [
            b64(&[7u8; 31]),
            b64(&[7u8; 33]),
            String::new(),
            format!("{}=", challenge()),
            challenge().replace('B', "+"),
            format!(" {}", challenge()),
            "not base64url!".to_string(),
        ] {
            assert_eq!(
                parse_get_request(Some(with(get_request(), "challenge", json!(bad)))),
                Err(INVALID_REQUEST),
                "{bad}"
            );
        }
        for allow in [
            json!([]),
            json!((0..17).map(|n| credential(n as u8)).collect::<Vec<_>>()),
            json!([b64(&[1u8; 15])]),
            json!([b64(&[1u8; 1024])]),
            json!(["***"]),
        ] {
            assert_eq!(
                parse_get_request(Some(with(get_request(), "allowCredentials", allow))),
                Err(INVALID_REQUEST)
            );
        }
        for timeout in [
            json!(0),
            json!(29_999),
            json!(180_001),
            json!(-1),
            json!(120_000.5),
            json!("120000"),
        ] {
            assert_eq!(
                parse_get_request(Some(with(get_request(), "timeoutMs", timeout))),
                Err(INVALID_REQUEST)
            );
        }
        // Boundaries that must pass.
        assert!(parse_get_request(Some(with(get_request(), "timeoutMs", json!(30_000)))).is_ok());
        assert!(parse_get_request(Some(with(get_request(), "timeoutMs", json!(180_000)))).is_ok());
        let edge = json!([b64(&[1u8; 16]), b64(&[2u8; 1023])]);
        assert!(parse_get_request(Some(with(get_request(), "allowCredentials", edge))).is_ok());
        let sixteen = json!((0..16).map(|n| credential(n as u8)).collect::<Vec<_>>());
        assert!(parse_get_request(Some(with(get_request(), "allowCredentials", sixteen))).is_ok());
    }

    #[test]
    fn malformed_request_shapes_are_invalid_requests() {
        assert_eq!(parse_get_request(None), Err(INVALID_REQUEST));
        assert_eq!(parse_get_request(Some(json!(null))), Err(INVALID_REQUEST));
        assert_eq!(
            parse_get_request(Some(json!("antara.tech"))),
            Err(INVALID_REQUEST)
        );
        assert_eq!(
            parse_get_request(Some(with(
                get_request(),
                "origin",
                json!("https://evil.example")
            ))),
            Err(INVALID_REQUEST)
        );
        assert_eq!(
            parse_get_request(Some(with(
                get_request(),
                "userVerification",
                json!("discouraged")
            ))),
            Err(INVALID_REQUEST)
        );
        let mut missing = get_request();
        missing.as_object_mut().unwrap().remove("allowCredentials");
        assert_eq!(parse_get_request(Some(missing)), Err(INVALID_REQUEST));
        assert_eq!(parse_create_request(None), Err(INVALID_REQUEST));
        assert_eq!(
            parse_create_request(Some(get_request())),
            Err(INVALID_REQUEST)
        );
    }

    #[test]
    fn passkey_create_validation_bounds_the_user_and_names() {
        let valid = parse_create_request(Some(create_request())).unwrap();
        assert_eq!(valid.rp_id, PRODUCTION_RP_ID);
        assert_eq!(valid.user_id, vec![9u8; 32]);
        assert!(valid.exclude_credentials.is_empty());
        assert!(parse_create_request(Some(with(
            create_request(),
            "excludeCredentials",
            json!([credential(3)])
        )))
        .is_ok());
        assert!(parse_create_request(Some(with(
            create_request(),
            "userId",
            json!(b64(&[1u8; 64]))
        )))
        .is_ok());

        assert_eq!(
            parse_create_request(Some(with(create_request(), "rpId", json!("example.com")))),
            Err(INVALID_REQUEST)
        );
        assert_eq!(
            parse_create_request(Some(with(
                create_request(),
                "challenge",
                json!(b64(&[1u8; 31]))
            ))),
            Err(INVALID_REQUEST)
        );
        assert_eq!(
            parse_create_request(Some(with(create_request(), "userId", json!("")))),
            Err(INVALID_REQUEST)
        );
        assert_eq!(
            parse_create_request(Some(with(
                create_request(),
                "userId",
                json!(b64(&[1u8; 65]))
            ))),
            Err(INVALID_REQUEST)
        );
        assert_eq!(
            parse_create_request(Some(with(create_request(), "timeoutMs", json!(29_999)))),
            Err(INVALID_REQUEST)
        );
        for field in ["rpName", "userName", "userDisplayName"] {
            for bad in [
                json!(""),
                json!("   "),
                json!("ANTARA\u{0}"),
                json!("A\nB"),
                json!("x".repeat(129)),
            ] {
                assert_eq!(
                    parse_create_request(Some(with(create_request(), field, bad))),
                    Err(INVALID_REQUEST),
                    "{field}"
                );
            }
        }
        let too_many = json!((0..17).map(|n| credential(n as u8)).collect::<Vec<_>>());
        assert_eq!(
            parse_create_request(Some(with(create_request(), "excludeCredentials", too_many))),
            Err(INVALID_REQUEST)
        );
        assert_eq!(
            parse_create_request(Some(with(
                create_request(),
                "excludeCredentials",
                json!([b64(&[1u8; 8])])
            ))),
            Err(INVALID_REQUEST)
        );
    }

    #[test]
    fn client_data_has_a_fixed_field_order_and_origin() {
        assert_eq!(
            client_data_json(Ceremony::Get, "BwcH"),
            r#"{"type":"webauthn.get","challenge":"BwcH","origin":"https://tauri.localhost","crossOrigin":false}"#
        );
        assert_eq!(
            client_data_json(Ceremony::Create, "BwcH"),
            r#"{"type":"webauthn.create","challenge":"BwcH","origin":"https://tauri.localhost","crossOrigin":false}"#
        );
    }

    #[test]
    fn client_data_escapes_its_values() {
        let hostile = r#"x","origin":"https://evil.example\"#;
        let text = client_data_json(Ceremony::Get, hostile);
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["challenge"], json!(hostile));
        assert_eq!(parsed["origin"], json!(LAYER_ORIGIN));
        assert_eq!(parsed.as_object().unwrap().len(), 4);
        assert!(text.starts_with(r#"{"type":"webauthn.get","challenge":"#));
    }

    #[test]
    fn only_not_allowed_maps_to_cancelled() {
        assert_eq!(map_webauthn_error("NotAllowedError"), PASSKEY_CANCELLED);
        for name in [
            "InvalidStateError",
            "ConstraintError",
            "NotSupportedError",
            "UnknownError",
            "Success",
            "",
            "notallowederror",
        ] {
            assert_eq!(map_webauthn_error(name), PASSKEY_FAILED, "{name}");
        }
    }

    #[test]
    fn transport_flags_map_to_webauthn_names() {
        assert_eq!(transports_from_flags(0), Vec::<&str>::new());
        assert_eq!(transports_from_flags(0x10), vec!["internal"]);
        assert_eq!(transports_from_flags(0x20), vec!["hybrid"]);
        assert_eq!(
            transports_from_flags(0x01 | 0x02 | 0x04),
            vec!["usb", "nfc", "ble"]
        );
        assert_eq!(
            transports_from_flags(0x08),
            Vec::<&str>::new(),
            "the test transport is never reported"
        );
    }

    /// The allow-list the assertion tests' credential (`credential(1)`) is in.
    fn allowed() -> Vec<Vec<u8>> {
        vec![vec![3u8; 20], vec![1u8; 32]]
    }

    fn authenticator_data(flags: u8) -> Vec<u8> {
        let mut data = vec![0xAAu8; 32];
        data.push(flags);
        data.extend_from_slice(&[0, 0, 0, 5]);
        data
    }

    #[test]
    fn assertion_response_has_exactly_the_contract_fields() {
        let parts = AssertionParts {
            credential_id: vec![1u8; 32],
            authenticator_data: authenticator_data(0x05),
            signature: vec![2u8; 70],
            user_handle: Vec::new(),
        };
        let client_data = client_data_json(Ceremony::Get, &challenge()).into_bytes();
        let response =
            serde_json::to_value(assertion_response(&parts, &client_data, &allowed()).unwrap())
                .unwrap();
        assert_eq!(
            response,
            json!({
                "id": credential(1),
                "rawId": credential(1),
                "type": "public-key",
                "response": {
                    "clientDataJSON": b64(&client_data),
                    "authenticatorData": b64(&authenticator_data(0x05)),
                    "signature": b64(&[2u8; 70]),
                    "userHandle": null,
                },
                "clientExtensionResults": {},
            })
        );
        let with_handle = AssertionParts {
            user_handle: vec![9u8; 32],
            ..parts.clone()
        };
        let response = serde_json::to_value(
            assertion_response(&with_handle, &client_data, &allowed()).unwrap(),
        )
        .unwrap();
        assert_eq!(response["response"]["userHandle"], json!(b64(&[9u8; 32])));
    }

    #[test]
    fn assertion_without_user_verification_or_data_is_refused() {
        let good = AssertionParts {
            credential_id: vec![1u8; 32],
            authenticator_data: authenticator_data(0x05),
            signature: vec![2u8; 70],
            user_handle: Vec::new(),
        };
        let client_data = b"{}";
        assert!(assertion_response(&good, client_data, &allowed()).is_ok());
        // A credential the request did not allow is refused.
        assert_eq!(
            assertion_response(&good, client_data, &[vec![2u8; 32]]),
            Err(PASSKEY_FAILED)
        );
        assert_eq!(
            assertion_response(&good, client_data, &[]),
            Err(PASSKEY_FAILED)
        );
        for bad in [
            AssertionParts {
                authenticator_data: authenticator_data(0x01),
                ..good.clone()
            },
            AssertionParts {
                authenticator_data: authenticator_data(0x04),
                ..good.clone()
            },
            AssertionParts {
                authenticator_data: authenticator_data(0x00),
                ..good.clone()
            },
            AssertionParts {
                authenticator_data: authenticator_data(0x05)[..36].to_vec(),
                ..good.clone()
            },
            AssertionParts {
                credential_id: Vec::new(),
                ..good.clone()
            },
            AssertionParts {
                credential_id: vec![1u8; 15],
                ..good.clone()
            },
            AssertionParts {
                signature: Vec::new(),
                ..good.clone()
            },
        ] {
            assert_eq!(
                assertion_response(&bad, client_data, &allowed()),
                Err(PASSKEY_FAILED)
            );
        }
        assert_eq!(
            assertion_response(&good, b"", &allowed()),
            Err(PASSKEY_FAILED)
        );
    }

    #[test]
    fn registration_response_has_exactly_the_contract_fields() {
        let parts = CredentialParts {
            credential_id: vec![4u8; 32],
            attestation_object: vec![0xA3, 1, 2, 3],
            authenticator_data: authenticator_data(0x45),
            used_transport: 0x10,
        };
        let client_data = client_data_json(Ceremony::Create, &challenge()).into_bytes();
        let response =
            serde_json::to_value(registration_response(&parts, &client_data, &[]).unwrap())
                .unwrap();
        assert_eq!(
            response,
            json!({
                "id": credential(4),
                "rawId": credential(4),
                "type": "public-key",
                "response": {
                    "clientDataJSON": b64(&client_data),
                    "attestationObject": b64(&[0xA3, 1, 2, 3]),
                    "transports": ["internal"],
                },
                "clientExtensionResults": {},
            })
        );
        let unknown_transport = CredentialParts {
            used_transport: 0,
            ..parts.clone()
        };
        let response = serde_json::to_value(
            registration_response(&unknown_transport, &client_data, &[]).unwrap(),
        )
        .unwrap();
        assert!(response["response"].get("transports").is_none());

        for bad in [
            CredentialParts {
                authenticator_data: authenticator_data(0x41),
                ..parts.clone()
            },
            CredentialParts {
                authenticator_data: authenticator_data(0x44),
                ..parts.clone()
            },
            CredentialParts {
                attestation_object: Vec::new(),
                ..parts.clone()
            },
            CredentialParts {
                credential_id: vec![4u8; 1024],
                ..parts.clone()
            },
        ] {
            assert_eq!(
                registration_response(&bad, &client_data, &[]),
                Err(PASSKEY_FAILED)
            );
        }
        // A "new" credential that the request excluded is refused.
        assert_eq!(
            registration_response(&parts, &client_data, &[vec![9u8; 16], vec![4u8; 32]]),
            Err(PASSKEY_FAILED)
        );
        assert!(registration_response(&parts, &client_data, &[vec![9u8; 16]]).is_ok());
    }

    #[test]
    fn only_one_ceremony_runs_at_a_time() {
        let first = CeremonyGuard::acquire().unwrap();
        assert!(CeremonyGuard::acquire().is_err());
        drop(first);
        let again = CeremonyGuard::acquire();
        assert!(again.is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn the_non_windows_stub_refuses_every_ceremony() {
        assert!(!std::hint::black_box(unavailable::SUPPORTED));
        let get = parse_get_request(Some(get_request())).unwrap();
        let create = parse_create_request(Some(create_request())).unwrap();
        assert_eq!(
            unavailable::get_assertion(0, &get, b"{}"),
            Err(UNSUPPORTED_PLATFORM)
        );
        assert_eq!(
            unavailable::make_credential(0, &create, b"{}"),
            Err(UNSUPPORTED_PLATFORM)
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn the_non_windows_stub_refuses_every_ceremony() {
        assert!(!std::hint::black_box(platform::SUPPORTED));
        let get = parse_get_request(Some(get_request())).unwrap();
        let create = parse_create_request(Some(create_request())).unwrap();
        assert_eq!(
            platform::get_assertion(0, &get, b"{}"),
            Err(UNSUPPORTED_PLATFORM)
        );
        assert_eq!(
            platform::make_credential(0, &create, b"{}"),
            Err(UNSUPPORTED_PLATFORM)
        );
    }
}
