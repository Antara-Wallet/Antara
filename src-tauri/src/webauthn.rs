//! Native Windows WebAuthn bridge.
//!
//! `navigator.credentials` does not work in the Tauri webview, so we call the
//! OS WebAuthn API (webauthn.dll) directly. That native dialog is also what
//! offers "use a phone" (hybrid/QR transport), which gives the cross-device
//! iPhone Face ID / Android fingerprint flow.
//!
//! The backend (relying party) generates standard @simplewebauthn options JSON
//! and verifies the response. These commands take that options JSON + the RP
//! origin, drive the OS ceremony, and return a response in the
//! RegistrationResponseJSON / AuthenticationResponseJSON shape the server expects.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, HWND};
use windows::Win32::Networking::WindowsWebServices::*;
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn b64d(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| format!("bad base64url: {e}"))
}

/// Null-terminated UTF-16 buffer for a PCWSTR. Keep the returned Vec alive while
/// the pointer is in use.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn read_bytes(ptr: *const u8, len: u32) -> Vec<u8> {
    if ptr.is_null() || len == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(ptr, len as usize).to_vec()
    }
}

const COSE_ES256: i32 = -7;
const COSE_RS256: i32 = -257;
const UV_REQUIRED: u32 = 1;
const ATTACHMENT_ANY: u32 = 0;
const ATTESTATION_NONE: u32 = 1;

/// Build the clientDataJSON the authenticator signs over.
fn client_data_json(ceremony_type: &str, challenge_b64: &str, origin: &str) -> String {
    format!(
        r#"{{"type":"{ceremony_type}","challenge":"{challenge_b64}","origin":"{origin}","crossOrigin":false}}"#
    )
}

#[tauri::command]
pub fn webauthn_make_credential(options: Value, origin: String) -> Result<Value, String> {
    let rp = options.get("rp").ok_or("missing rp")?;
    let rp_id = rp.get("id").and_then(|v| v.as_str()).ok_or("missing rp.id")?;
    let rp_name = rp.get("name").and_then(|v| v.as_str()).unwrap_or(rp_id);

    let user = options.get("user").ok_or("missing user")?;
    let user_id = b64d(user.get("id").and_then(|v| v.as_str()).ok_or("missing user.id")?)?;
    let user_name = user.get("name").and_then(|v| v.as_str()).unwrap_or("user");
    let user_display = user
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(user_name);

    let challenge = options
        .get("challenge")
        .and_then(|v| v.as_str())
        .ok_or("missing challenge")?;
    let timeout = options.get("timeout").and_then(|v| v.as_u64()).unwrap_or(60_000) as u32;

    // Algorithms the RP accepts (default ES256 + RS256).
    let algs: Vec<i32> = options
        .get("pubKeyCredParams")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.get("alg").and_then(|a| a.as_i64()).map(|a| a as i32))
                .collect()
        })
        .filter(|v: &Vec<i32>| !v.is_empty())
        .unwrap_or_else(|| vec![COSE_ES256, COSE_RS256]);

    let cdj = client_data_json("webauthn.create", challenge, &origin);

    // --- keep all backing buffers alive until after the FFI call ---
    let w_rp_id = wide(rp_id);
    let w_rp_name = wide(rp_name);
    let w_user_name = wide(user_name);
    let w_user_display = wide(user_display);
    let w_pubkey = wide("public-key");
    let w_sha256 = wide("SHA-256");
    let mut user_id_buf = user_id.clone();
    let mut cdj_buf = cdj.into_bytes();

    unsafe {
        let hwnd: HWND = GetForegroundWindow();

        let rp_info = WEBAUTHN_RP_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
            pwszId: PCWSTR(w_rp_id.as_ptr()),
            pwszName: PCWSTR(w_rp_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
        };

        let user_info = WEBAUTHN_USER_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
            cbId: user_id_buf.len() as u32,
            pbId: user_id_buf.as_mut_ptr(),
            pwszName: PCWSTR(w_user_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
            pwszDisplayName: PCWSTR(w_user_display.as_ptr()),
        };

        let mut cose_params: Vec<WEBAUTHN_COSE_CREDENTIAL_PARAMETER> = algs
            .iter()
            .map(|alg| WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
                dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
                pwszCredentialType: PCWSTR(w_pubkey.as_ptr()),
                lAlg: *alg,
            })
            .collect();
        let cose_params_list = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
            cCredentialParameters: cose_params.len() as u32,
            pCredentialParameters: cose_params.as_mut_ptr(),
        };

        let client_data = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: cdj_buf.len() as u32,
            pbClientDataJSON: cdj_buf.as_mut_ptr(),
            pwszHashAlgId: PCWSTR(w_sha256.as_ptr()),
        };

        let make_opts = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
            dwVersion: 1,
            dwTimeoutMilliseconds: timeout,
            dwAuthenticatorAttachment: ATTACHMENT_ANY,
            bRequireResidentKey: BOOL(0),
            dwUserVerificationRequirement: UV_REQUIRED,
            dwAttestationConveyancePreference: ATTESTATION_NONE,
            ..Default::default()
        };

        let result = WebAuthNAuthenticatorMakeCredential(
            hwnd,
            &rp_info,
            &user_info,
            &cose_params_list,
            &client_data,
            Some(&make_opts),
        );
        // touch buffers so they aren't dropped before the call returns
        let _ = (&cose_params, &user_id_buf, &cdj_buf);

        let att_ptr = result.map_err(|e| format!("WebAuthn make credential failed: {e}"))?;
        if att_ptr.is_null() {
            return Err("WebAuthn returned no attestation".into());
        }
        let att = &*att_ptr;
        let credential_id = read_bytes(att.pbCredentialId, att.cbCredentialId);
        let attestation_object = read_bytes(att.pbAttestationObject, att.cbAttestationObject);
        WebAuthNFreeCredentialAttestation(Some(att_ptr as *const _));

        let id = b64(&credential_id);
        Ok(json!({
            "id": id,
            "rawId": id,
            "type": "public-key",
            "response": {
                "clientDataJSON": b64(&cdj_buf),
                "attestationObject": b64(&attestation_object),
            },
            "clientExtensionResults": {},
            "authenticatorAttachment": "cross-platform",
        }))
    }
}

#[tauri::command]
pub fn webauthn_get_assertion(options: Value, origin: String) -> Result<Value, String> {
    let rp_id = options
        .get("rpId")
        .and_then(|v| v.as_str())
        .ok_or("missing rpId")?;
    let challenge = options
        .get("challenge")
        .and_then(|v| v.as_str())
        .ok_or("missing challenge")?;
    let timeout = options.get("timeout").and_then(|v| v.as_u64()).unwrap_or(60_000) as u32;

    // allowCredentials -> WEBAUTHN_CREDENTIALS (legacy list, version 1).
    let allow: Vec<Vec<u8>> = options
        .get("allowCredentials")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("id").and_then(|i| i.as_str()))
                .filter_map(|s| b64d(s).ok())
                .collect()
        })
        .unwrap_or_default();

    let cdj = client_data_json("webauthn.get", challenge, &origin);

    let w_rp_id = wide(rp_id);
    let w_pubkey = wide("public-key");
    let w_sha256 = wide("SHA-256");
    let mut cdj_buf = cdj.into_bytes();
    let mut allow_bufs = allow; // keep id bytes alive

    unsafe {
        let hwnd: HWND = GetForegroundWindow();

        let mut creds: Vec<WEBAUTHN_CREDENTIAL> = allow_bufs
            .iter_mut()
            .map(|id| WEBAUTHN_CREDENTIAL {
                dwVersion: WEBAUTHN_CREDENTIAL_CURRENT_VERSION,
                cbId: id.len() as u32,
                pbId: id.as_mut_ptr(),
                pwszCredentialType: PCWSTR(w_pubkey.as_ptr()),
            })
            .collect();

        let client_data = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: cdj_buf.len() as u32,
            pbClientDataJSON: cdj_buf.as_mut_ptr(),
            pwszHashAlgId: PCWSTR(w_sha256.as_ptr()),
        };

        let get_opts = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
            dwVersion: 1,
            dwTimeoutMilliseconds: timeout,
            CredentialList: WEBAUTHN_CREDENTIALS {
                cCredentials: creds.len() as u32,
                pCredentials: creds.as_mut_ptr(),
            },
            dwAuthenticatorAttachment: ATTACHMENT_ANY,
            dwUserVerificationRequirement: UV_REQUIRED,
            ..Default::default()
        };

        let result =
            WebAuthNAuthenticatorGetAssertion(hwnd, PCWSTR(w_rp_id.as_ptr()), &client_data, Some(&get_opts));
        let _ = (&creds, &cdj_buf);

        let asr_ptr = result.map_err(|e| format!("WebAuthn get assertion failed: {e}"))?;
        if asr_ptr.is_null() {
            return Err("WebAuthn returned no assertion".into());
        }
        let asr = &*asr_ptr;
        let authenticator_data = read_bytes(asr.pbAuthenticatorData, asr.cbAuthenticatorData);
        let signature = read_bytes(asr.pbSignature, asr.cbSignature);
        let credential_id = read_bytes(asr.Credential.pbId, asr.Credential.cbId);
        let user_id = read_bytes(asr.pbUserId, asr.cbUserId);
        WebAuthNFreeAssertion(asr_ptr as *const _);

        let id = b64(&credential_id);
        Ok(json!({
            "id": id,
            "rawId": id,
            "type": "public-key",
            "response": {
                "clientDataJSON": b64(&cdj_buf),
                "authenticatorData": b64(&authenticator_data),
                "signature": b64(&signature),
                "userHandle": if user_id.is_empty() { Value::Null } else { json!(b64(&user_id)) },
            },
            "clientExtensionResults": {},
            "authenticatorAttachment": "cross-platform",
        }))
    }
}
