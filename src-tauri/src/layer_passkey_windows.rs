//! webauthn.dll calls for the vault-layer passkey commands. Every input has
//! already been validated by `layer_passkey`; the relying-party ID passed here
//! is one of the compiled constants, and the clientDataJSON is built in Rust.

use super::{
    map_webauthn_error, AssertionParts, CredentialParts, ValidCreateRequest, ValidGetRequest,
    COSE_ES256, COSE_RS256, PASSKEY_FAILED,
};
use std::ffi::c_void;
use tauri::{AppHandle, Manager};
use windows::core::{HRESULT, PCWSTR};
use windows::Win32::Foundation::{BOOL, HWND};
use windows::Win32::Networking::WindowsWebServices::{
    WebAuthNAuthenticatorGetAssertion, WebAuthNAuthenticatorMakeCredential, WebAuthNFreeAssertion,
    WebAuthNFreeCredentialAttestation, WebAuthNGetErrorName, WEBAUTHN_ASSERTION,
    WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE, WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
    WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
    WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_1,
    WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS,
    WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_1, WEBAUTHN_CLIENT_DATA,
    WEBAUTHN_CLIENT_DATA_CURRENT_VERSION, WEBAUTHN_COSE_CREDENTIAL_PARAMETER,
    WEBAUTHN_COSE_CREDENTIAL_PARAMETERS, WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
    WEBAUTHN_CREDENTIAL, WEBAUTHN_CREDENTIALS, WEBAUTHN_CREDENTIAL_ATTESTATION,
    WEBAUTHN_CREDENTIAL_ATTESTATION_VERSION_3, WEBAUTHN_CREDENTIAL_CURRENT_VERSION,
    WEBAUTHN_RP_ENTITY_INFORMATION, WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
    WEBAUTHN_USER_ENTITY_INFORMATION, WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
    WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
};

pub const SUPPORTED: bool = true;

/// The main window's HWND (not whatever window is in the foreground), so the
/// Windows Security dialog is owned by ANTARA. Passed as an integer because a
/// raw pointer cannot cross to the blocking worker thread.
pub fn parent_window(app: &AppHandle) -> Result<isize, &'static str> {
    let window = app.get_window("main").ok_or(PASSKEY_FAILED)?;
    let hwnd = window.hwnd().map_err(|_| PASSKEY_FAILED)?;
    Ok(hwnd.0 as isize)
}

/// Null-terminated UTF-16; keep the Vec alive while the pointer is in use.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Copies `len` bytes out of memory owned by webauthn.dll.
unsafe fn copy_bytes(ptr: *const u8, len: u32) -> Vec<u8> {
    if ptr.is_null() || len == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(ptr, len as usize).to_vec()
    }
}

/// Windows reports the W3C DOM error name for a failed ceremony.
fn map_error(code: HRESULT) -> &'static str {
    // SAFETY: WebAuthNGetErrorName returns a static, NUL-terminated string.
    let name = unsafe {
        let name = WebAuthNGetErrorName(code);
        if name.is_null() {
            String::new()
        } else {
            name.to_string().unwrap_or_default()
        }
    };
    map_webauthn_error(&name)
}

/// The legacy (version 1) credential list: allow-list for an assertion,
/// exclude-list for a registration.
fn credential_list(ids: &mut [Vec<u8>], credential_type: &[u16]) -> Vec<WEBAUTHN_CREDENTIAL> {
    ids.iter_mut()
        .map(|id| WEBAUTHN_CREDENTIAL {
            dwVersion: WEBAUTHN_CREDENTIAL_CURRENT_VERSION,
            cbId: id.len() as u32,
            pbId: id.as_mut_ptr(),
            pwszCredentialType: PCWSTR(credential_type.as_ptr()),
        })
        .collect()
}

pub fn get_assertion(
    parent: isize,
    request: &ValidGetRequest,
    client_data: &[u8],
) -> Result<AssertionParts, &'static str> {
    // Every buffer below outlives the FFI call that points into it.
    let rp_id = wide(request.rp_id);
    let credential_type = wide("public-key");
    let hash_algorithm = wide("SHA-256");
    let mut client_data = client_data.to_vec();
    let mut allow = request.allow_credentials.clone();
    let mut credentials = credential_list(&mut allow, &credential_type);

    let client = WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: client_data.len() as u32,
        pbClientDataJSON: client_data.as_mut_ptr(),
        pwszHashAlgId: PCWSTR(hash_algorithm.as_ptr()),
    };
    let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
        dwVersion: WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_1,
        dwTimeoutMilliseconds: request.timeout_ms,
        CredentialList: WEBAUTHN_CREDENTIALS {
            cCredentials: credentials.len() as u32,
            pCredentials: credentials.as_mut_ptr(),
        },
        dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
        dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        ..Default::default()
    };

    let result = unsafe {
        WebAuthNAuthenticatorGetAssertion(
            HWND(parent as *mut c_void),
            PCWSTR(rp_id.as_ptr()),
            &client,
            Some(&options),
        )
    };
    let assertion: *mut WEBAUTHN_ASSERTION = match result {
        Ok(assertion) if !assertion.is_null() => assertion,
        Ok(_) => return Err(PASSKEY_FAILED),
        Err(error) => return Err(map_error(error.code())),
    };
    // SAFETY: a non-null assertion from webauthn.dll; copied, then freed once.
    let parts = unsafe {
        let value = &*assertion;
        AssertionParts {
            credential_id: copy_bytes(value.Credential.pbId, value.Credential.cbId),
            authenticator_data: copy_bytes(value.pbAuthenticatorData, value.cbAuthenticatorData),
            signature: copy_bytes(value.pbSignature, value.cbSignature),
            user_handle: copy_bytes(value.pbUserId, value.cbUserId),
        }
    };
    unsafe { WebAuthNFreeAssertion(assertion) };
    Ok(parts)
}

pub fn make_credential(
    parent: isize,
    request: &ValidCreateRequest,
    client_data: &[u8],
) -> Result<CredentialParts, &'static str> {
    // Every buffer below outlives the FFI call that points into it.
    let rp_id = wide(request.rp_id);
    let rp_name = wide(&request.rp_name);
    let user_name = wide(&request.user_name);
    let user_display_name = wide(&request.user_display_name);
    let credential_type = wide("public-key");
    let hash_algorithm = wide("SHA-256");
    let mut user_id = request.user_id.clone();
    let mut client_data = client_data.to_vec();
    let mut exclude = request.exclude_credentials.clone();
    let mut excluded = credential_list(&mut exclude, &credential_type);

    let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
        dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
        pwszId: PCWSTR(rp_id.as_ptr()),
        pwszName: PCWSTR(rp_name.as_ptr()),
        pwszIcon: PCWSTR::null(),
    };
    let user = WEBAUTHN_USER_ENTITY_INFORMATION {
        dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
        cbId: user_id.len() as u32,
        pbId: user_id.as_mut_ptr(),
        pwszName: PCWSTR(user_name.as_ptr()),
        pwszIcon: PCWSTR::null(),
        pwszDisplayName: PCWSTR(user_display_name.as_ptr()),
    };
    // ES256 and RS256 only, whatever the caller might prefer.
    let mut algorithms: Vec<WEBAUTHN_COSE_CREDENTIAL_PARAMETER> = [COSE_ES256, COSE_RS256]
        .iter()
        .map(|algorithm| WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
            dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
            pwszCredentialType: PCWSTR(credential_type.as_ptr()),
            lAlg: *algorithm,
        })
        .collect();
    let parameters = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
        cCredentialParameters: algorithms.len() as u32,
        pCredentialParameters: algorithms.as_mut_ptr(),
    };
    let client = WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: client_data.len() as u32,
        pbClientDataJSON: client_data.as_mut_ptr(),
        pwszHashAlgId: PCWSTR(hash_algorithm.as_ptr()),
    };
    let options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
        dwVersion: WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_1,
        dwTimeoutMilliseconds: request.timeout_ms,
        CredentialList: WEBAUTHN_CREDENTIALS {
            cCredentials: excluded.len() as u32,
            pCredentials: excluded.as_mut_ptr(),
        },
        dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
        bRequireResidentKey: BOOL(0),
        dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
        ..Default::default()
    };

    let result = unsafe {
        WebAuthNAuthenticatorMakeCredential(
            HWND(parent as *mut c_void),
            &rp,
            &user,
            &parameters,
            &client,
            Some(&options),
        )
    };
    let attestation: *mut WEBAUTHN_CREDENTIAL_ATTESTATION = match result {
        Ok(attestation) if !attestation.is_null() => attestation,
        Ok(_) => return Err(PASSKEY_FAILED),
        Err(error) => return Err(map_error(error.code())),
    };
    // SAFETY: a non-null attestation from webauthn.dll; copied, then freed once.
    // `dwUsedTransport` exists only from structure version 3.
    let parts = unsafe {
        let value = &*attestation;
        CredentialParts {
            credential_id: copy_bytes(value.pbCredentialId, value.cbCredentialId),
            attestation_object: copy_bytes(value.pbAttestationObject, value.cbAttestationObject),
            authenticator_data: copy_bytes(value.pbAuthenticatorData, value.cbAuthenticatorData),
            used_transport: if value.dwVersion >= WEBAUTHN_CREDENTIAL_ATTESTATION_VERSION_3 {
                value.dwUsedTransport
            } else {
                0
            },
        }
    };
    unsafe { WebAuthNFreeCredentialAttestation(Some(attestation as *const _)) };
    Ok(parts)
}
