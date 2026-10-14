//! The vault-layer passkey commands need Windows' webauthn.dll. Other
//! platforms refuse every ceremony instead of inventing a credential.
#![allow(dead_code)]

use super::{
    AssertionParts, CredentialParts, ValidCreateRequest, ValidGetRequest, UNSUPPORTED_PLATFORM,
};
use tauri::AppHandle;

pub const SUPPORTED: bool = false;

pub fn parent_window(_app: &AppHandle) -> Result<isize, &'static str> {
    Err(UNSUPPORTED_PLATFORM)
}

pub fn get_assertion(
    _parent: isize,
    _request: &ValidGetRequest,
    _client_data: &[u8],
) -> Result<AssertionParts, &'static str> {
    Err(UNSUPPORTED_PLATFORM)
}

pub fn make_credential(
    _parent: isize,
    _request: &ValidCreateRequest,
    _client_data: &[u8],
) -> Result<CredentialParts, &'static str> {
    Err(UNSUPPORTED_PLATFORM)
}
