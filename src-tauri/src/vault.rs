//! Vault core — the only place plaintext key material ever lives.
//!
//! Design: the BIP39 mnemonic is encrypted at rest with AES-256-GCM, keyed by
//! the user's password through Argon2id (memory-hard). The decrypted seed lives
//! ONLY in this Rust process (a `Mutex<Option<Unlocked>>`); the JS/webview side
//! receives addresses and signatures, never the seed or any private key.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use bip32::{DerivationPath, XPrv};
use bip39::{Language, Mnemonic};
use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::stealth;

const VAULT_FILE: &str = "vault.dat";
const VERSION: u32 = 1;

/// Imported accounts live above any realistic HD index, so `sign_hash` can tell
/// from the index alone whether to derive from the seed or use a standalone key.
const IMPORTED_BASE: u32 = 0x1000_0000; // 268,435,456

/// A standalone imported account held in memory while unlocked. The raw key is
/// zeroized on drop.
struct ImportedAccount {
    index: u32,
    key: Zeroizing<[u8; 32]>, // raw secp256k1 private key
    address: String,
}

/// In-memory state of an unlocked vault. The seed is zeroized on drop.
pub struct Unlocked {
    seed: Zeroizing<[u8; 64]>,
    account_count: u32,
    imported: Vec<ImportedAccount>,
}

#[derive(Default)]
pub struct VaultState(pub Mutex<Option<Unlocked>>);

/// On-disk record. Everything here is safe to persist: the ciphertext is
/// useless without the password, salt/nonce are public by design.
#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    kdf: String,
    salt: String,       // hex, 16 bytes
    nonce: String,      // hex, 12 bytes
    ciphertext: String, // hex, AES-256-GCM(mnemonic utf-8)
    account_count: u32,
    // Standalone keys imported by the user (external wallets), each sealed under
    // the same password-derived key with its own nonce. Absent in older vaults.
    #[serde(default)]
    imported: Vec<ImportedRecord>,
}

/// An imported private key as persisted on disk. Encrypted with the same KEK as
/// the mnemonic (password + the file's salt), but a fresh per-record nonce.
#[derive(Serialize, Deserialize, Clone)]
struct ImportedRecord {
    index: u32,
    nonce: String,      // hex, 12 bytes
    ciphertext: String, // hex, AES-256-GCM(raw 32-byte private key)
}

#[derive(Serialize)]
pub struct Account {
    index: u32,
    address: String,
}

#[derive(Serialize)]
pub struct CreatedVault {
    mnemonic: String, // shown once for backup, then discarded by the UI
    account: Account,
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(VAULT_FILE))
}

fn derive_kek(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let mut kek = Zeroizing::new([0u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, kek.as_mut())
        .map_err(|e| format!("kdf failed: {e}"))?;
    Ok(kek)
}

/// Seal a mnemonic to disk and return the persisted record fields.
fn seal(password: &str, mnemonic: &str, account_count: u32) -> Result<VaultFile, String> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce);

    let kek = derive_kek(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(kek.as_ref()).map_err(|e| e.to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), mnemonic.as_bytes())
        .map_err(|_| "encryption failed".to_string())?;

    Ok(VaultFile {
        version: VERSION,
        kdf: "argon2id".into(),
        salt: hex::encode(salt),
        nonce: hex::encode(nonce),
        ciphertext: hex::encode(ciphertext),
        account_count,
        imported: Vec::new(),
    })
}

/// Decrypt the mnemonic from a record. Wrong password => AES-GCM tag mismatch.
fn unseal(password: &str, file: &VaultFile) -> Result<Zeroizing<String>, String> {
    let salt = hex::decode(&file.salt).map_err(|e| e.to_string())?;
    let nonce = hex::decode(&file.nonce).map_err(|e| e.to_string())?;
    let ciphertext = hex::decode(&file.ciphertext).map_err(|e| e.to_string())?;

    let kek = derive_kek(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(kek.as_ref()).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "invalid password".to_string())?;
    let mnemonic = String::from_utf8(plaintext).map_err(|_| "corrupt vault".to_string())?;
    Ok(Zeroizing::new(mnemonic))
}

fn read_file(app: &AppHandle) -> Result<VaultFile, String> {
    let path = vault_path(app)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_file(app: &AppHandle, file: &VaultFile) -> Result<(), String> {
    let path = vault_path(app)?;
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

fn mnemonic_to_seed(mnemonic: &str) -> Result<Zeroizing<[u8; 64]>, String> {
    let m = Mnemonic::parse_in_normalized(Language::English, mnemonic)
        .map_err(|_| "invalid recovery phrase".to_string())?;
    Ok(Zeroizing::new(m.to_seed("")))
}

/// Derive the secp256k1 signing key at m/44'/60'/0'/0/index from the seed.
fn signing_key(seed: &[u8; 64], index: u32) -> Result<SigningKey, String> {
    let path: DerivationPath = format!("m/44'/60'/0'/0/{index}")
        .parse()
        .map_err(|_| "bad derivation path".to_string())?;
    let xprv = XPrv::derive_from_path(seed, &path).map_err(|e| e.to_string())?;
    Ok(xprv.private_key().clone())
}

/// Rebuild a signing key from raw 32 bytes (for imported standalone keys).
fn signing_key_from_bytes(bytes: &[u8; 32]) -> Result<SigningKey, String> {
    SigningKey::from_slice(bytes).map_err(|_| "invalid private key".to_string())
}

/// Parse a user-supplied secret into a raw private key. Accepts either a 32-byte
/// hex private key (with or without 0x) or a BIP39 mnemonic (whose account 0 we
/// take). Validates the result is a usable secp256k1 key.
fn private_key_from_secret(secret: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let s = secret.trim();
    let hexpart = s.strip_prefix("0x").unwrap_or(s);
    if hexpart.len() == 64 && hexpart.chars().all(|c| c.is_ascii_hexdigit()) {
        let bytes = hex::decode(hexpart).map_err(|e| e.to_string())?;
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        signing_key_from_bytes(&arr)?; // validate
        return Ok(Zeroizing::new(arr));
    }
    // Otherwise treat it as a recovery phrase and take its first account.
    let seed = mnemonic_to_seed(s)?;
    let sk = signing_key(&seed, 0)?;
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&sk.to_bytes());
    Ok(Zeroizing::new(arr))
}

/// AES-GCM cipher keyed by the password + the file's salt (the KEK). Used to
/// seal/open both the mnemonic and any imported keys.
fn cipher_for(password: &str, file: &VaultFile) -> Result<Aes256Gcm, String> {
    let salt = hex::decode(&file.salt).map_err(|e| e.to_string())?;
    let kek = derive_kek(password, &salt)?;
    Aes256Gcm::new_from_slice(kek.as_ref()).map_err(|e| e.to_string())
}

/// Decrypt all imported records into in-memory accounts (addresses + keys).
fn decrypt_imported(cipher: &Aes256Gcm, file: &VaultFile) -> Result<Vec<ImportedAccount>, String> {
    let mut out = Vec::with_capacity(file.imported.len());
    for rec in &file.imported {
        let nonce = hex::decode(&rec.nonce).map_err(|e| e.to_string())?;
        let ct = hex::decode(&rec.ciphertext).map_err(|e| e.to_string())?;
        let pt = cipher
            .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
            .map_err(|_| "corrupt imported key".to_string())?;
        if pt.len() != 32 {
            return Err("corrupt imported key".into());
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&pt);
        let address = address_of(&signing_key_from_bytes(&arr)?);
        out.push(ImportedAccount {
            index: rec.index,
            key: Zeroizing::new(arr),
            address,
        });
    }
    Ok(out)
}

/// EIP-55 checksummed 0x address from a signing key.
fn address_of(sk: &SigningKey) -> String {
    let vk = sk.verifying_key();
    let point = vk.to_encoded_point(false); // uncompressed: 0x04 || X || Y
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    let raw = &hash[12..32]; // last 20 bytes

    let lower = hex::encode(raw);
    let hash_of_hex = Keccak256::digest(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, ch) in lower.chars().enumerate() {
        if ch.is_ascii_digit() {
            out.push(ch);
        } else {
            let nibble = (hash_of_hex[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0x0f;
            if nibble >= 8 {
                out.push(ch.to_ascii_uppercase());
            } else {
                out.push(ch);
            }
        }
    }
    out
}

fn account_at(seed: &[u8; 64], index: u32) -> Result<Account, String> {
    let sk = signing_key(seed, index)?;
    Ok(Account {
        index,
        address: address_of(&sk),
    })
}

fn accounts(seed: &[u8; 64], count: u32) -> Result<Vec<Account>, String> {
    (0..count).map(|i| account_at(seed, i)).collect()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn vault_exists(app: AppHandle) -> bool {
    vault_path(&app).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn create_vault(
    app: AppHandle,
    state: State<VaultState>,
    password: String,
) -> Result<CreatedVault, String> {
    if vault_path(&app)?.exists() {
        return Err("a vault already exists on this device".into());
    }
    let mnemonic = Mnemonic::generate_in(Language::English, 12)
        .map_err(|e| e.to_string())?
        .to_string();
    let mnemonic = Zeroizing::new(mnemonic);

    let file = seal(&password, &mnemonic, 1)?;
    write_file(&app, &file)?;

    let seed = mnemonic_to_seed(&mnemonic)?;
    let account = account_at(&seed, 0)?;
    *state.0.lock().unwrap() = Some(Unlocked {
        seed,
        account_count: 1,
        imported: Vec::new(),
    });

    Ok(CreatedVault {
        mnemonic: mnemonic.to_string(),
        account,
    })
}

#[tauri::command]
pub fn import_vault(
    app: AppHandle,
    state: State<VaultState>,
    password: String,
    mnemonic: String,
) -> Result<Account, String> {
    if vault_path(&app)?.exists() {
        return Err("a vault already exists on this device".into());
    }
    let mnemonic = Zeroizing::new(mnemonic.trim().to_string());
    // Validates the phrase (checksum + wordlist) before we persist anything.
    let seed = mnemonic_to_seed(&mnemonic)?;

    let file = seal(&password, &mnemonic, 1)?;
    write_file(&app, &file)?;

    let account = account_at(&seed, 0)?;
    *state.0.lock().unwrap() = Some(Unlocked {
        seed,
        account_count: 1,
        imported: Vec::new(),
    });
    Ok(account)
}

#[tauri::command]
pub fn unlock_vault(
    app: AppHandle,
    state: State<VaultState>,
    password: String,
) -> Result<Vec<Account>, String> {
    let file = read_file(&app)?;
    let mnemonic = unseal(&password, &file)?;
    let seed = mnemonic_to_seed(&mnemonic)?;
    let cipher = cipher_for(&password, &file)?;
    let imported = decrypt_imported(&cipher, &file)?;

    let mut list = accounts(&seed, file.account_count)?;
    for a in &imported {
        list.push(Account {
            index: a.index,
            address: a.address.clone(),
        });
    }
    *state.0.lock().unwrap() = Some(Unlocked {
        seed,
        account_count: file.account_count,
        imported,
    });
    Ok(list)
}

#[tauri::command]
pub fn lock_vault(state: State<VaultState>) {
    *state.0.lock().unwrap() = None; // Zeroizing drops zero the seed
}

#[tauri::command]
pub fn list_accounts(state: State<VaultState>) -> Result<Vec<Account>, String> {
    let guard = state.0.lock().unwrap();
    let u = guard.as_ref().ok_or("vault is locked")?;
    let mut list = accounts(&u.seed, u.account_count)?;
    for a in &u.imported {
        list.push(Account {
            index: a.index,
            address: a.address.clone(),
        });
    }
    Ok(list)
}

/// Import an external wallet (a recovery phrase or a raw private key) as a
/// standalone account alongside the HD-derived ones. Re-authenticates with the
/// password so the new key can be sealed under the same KEK. The key is encrypted
/// at rest and only ever lives in this Rust process while unlocked.
#[tauri::command]
pub fn import_account(
    app: AppHandle,
    state: State<VaultState>,
    password: String,
    secret: String,
) -> Result<Account, String> {
    let mut guard = state.0.lock().unwrap();
    let u = guard.as_mut().ok_or("vault is locked")?;

    let mut file = read_file(&app)?;
    // Re-authenticate: a wrong password fails to open the existing vault.
    let _ = unseal(&password, &file)?;
    let cipher = cipher_for(&password, &file)?;

    let privkey = private_key_from_secret(&secret)?;
    let address = address_of(&signing_key_from_bytes(&privkey)?);

    // Reject a wallet already present (HD-derived or previously imported).
    let already = accounts(&u.seed, u.account_count)?
        .iter()
        .any(|a| a.address.eq_ignore_ascii_case(&address))
        || u.imported.iter().any(|a| a.address.eq_ignore_ascii_case(&address));
    if already {
        return Err("this wallet is already in your vault".into());
    }

    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), &privkey[..])
        .map_err(|_| "encryption failed".to_string())?;

    // Indices are monotonic (we never reuse), so removing one in the UI can't
    // collide a future import onto a stale key.
    let index = IMPORTED_BASE
        + file
            .imported
            .iter()
            .map(|r| r.index - IMPORTED_BASE + 1)
            .max()
            .unwrap_or(0);
    file.imported.push(ImportedRecord {
        index,
        nonce: hex::encode(nonce),
        ciphertext: hex::encode(ciphertext),
    });
    write_file(&app, &file)?;

    u.imported.push(ImportedAccount {
        index,
        key: privkey,
        address: address.clone(),
    });

    Ok(Account { index, address })
}

#[tauri::command]
pub fn add_account(app: AppHandle, state: State<VaultState>) -> Result<Account, String> {
    let mut guard = state.0.lock().unwrap();
    let u = guard.as_mut().ok_or("vault is locked")?;
    let new_index = u.account_count;
    let account = account_at(&u.seed, new_index)?;

    // Persist the bumped count so the account reappears after a restart.
    let mut file = read_file(&app)?;
    file.account_count = new_index + 1;
    write_file(&app, &file)?;
    u.account_count = new_index + 1;

    Ok(account)
}

/// Sign a 32-byte digest (e.g. an EIP-712 SafeTx hash) with the account key.
/// Returns 65-byte r||s||v hex with v in {27,28}. The key never leaves Rust.
#[tauri::command]
pub fn sign_hash(state: State<VaultState>, index: u32, hash: String) -> Result<String, String> {
    let digest = hex::decode(hash.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    if digest.len() != 32 {
        return Err("hash must be 32 bytes".into());
    }
    let guard = state.0.lock().unwrap();
    let u = guard.as_ref().ok_or("vault is locked")?;
    let sk = if index >= IMPORTED_BASE {
        let acc = u
            .imported
            .iter()
            .find(|a| a.index == index)
            .ok_or("unknown account")?;
        signing_key_from_bytes(&acc.key)?
    } else {
        signing_key(&u.seed, index)?
    };

    let (sig, recid): (Signature, RecoveryId) = sk
        .sign_prehash_recoverable(&digest)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(65);
    out.extend_from_slice(&sig.to_bytes());
    out.push(27 + recid.to_byte());
    Ok(format!("0x{}", hex::encode(out)))
}

/// Re-authenticate with the password and return the mnemonic for one-time
/// display (Settings -> Reveal). Does not rely on the in-memory seed.
#[tauri::command]
pub fn reveal_mnemonic(app: AppHandle, password: String) -> Result<String, String> {
    let file = read_file(&app)?;
    let mnemonic = unseal(&password, &file)?;
    Ok(mnemonic.to_string())
}

/// Re-authenticate with the password and return one account's raw private key
/// (hex) for one-time display/backup. Like `reveal_mnemonic`, this re-derives
/// from the sealed seed and never persists the key. The key only crosses into
/// JS at the user's explicit request, for export.
#[tauri::command]
pub fn reveal_private_key(app: AppHandle, password: String, index: u32) -> Result<String, String> {
    let file = read_file(&app)?;
    // Re-authenticate against the mnemonic record (wrong password fails here).
    let mnemonic = unseal(&password, &file)?;
    if index >= IMPORTED_BASE {
        let rec = file
            .imported
            .iter()
            .find(|r| r.index == index)
            .ok_or("unknown account")?;
        let cipher = cipher_for(&password, &file)?;
        let nonce = hex::decode(&rec.nonce).map_err(|e| e.to_string())?;
        let ct = hex::decode(&rec.ciphertext).map_err(|e| e.to_string())?;
        let pt = cipher
            .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
            .map_err(|_| "corrupt imported key".to_string())?;
        return Ok(format!("0x{}", hex::encode(pt)));
    }
    let seed = mnemonic_to_seed(&mnemonic)?;
    let sk = signing_key(&seed, index)?;
    Ok(format!("0x{}", hex::encode(sk.to_bytes())))
}

// ---------------------------------------------------------------------------
// Stealth addresses (ERC-5564) — private receiving. The spending key is the
// account key (HD-derived or imported); the viewing key is derived from it in
// `stealth`. All EC math stays in Rust; JS only ever sees pubkeys/addresses.
// ---------------------------------------------------------------------------

/// Raw private key for any account index (HD-derived or imported).
fn account_key_bytes(u: &Unlocked, index: u32) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    if index >= IMPORTED_BASE {
        let acc = u
            .imported
            .iter()
            .find(|a| a.index == index)
            .ok_or("unknown account")?;
        out.copy_from_slice(&acc.key[..]);
    } else {
        let sk = signing_key(&u.seed, index)?;
        out.copy_from_slice(&sk.to_bytes());
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StealthMeta {
    spend_pub: String,
    view_pub: String,
    meta: String,
}

/// The account's stealth meta-address to publish/share so others can pay it
/// privately.
#[tauri::command]
pub fn stealth_meta_address(
    state: State<VaultState>,
    index: u32,
    chain: String,
) -> Result<StealthMeta, String> {
    let guard = state.0.lock().unwrap();
    let u = guard.as_ref().ok_or("vault is locked")?;
    let key = account_key_bytes(u, index)?;
    let m = stealth::meta_address(&key, &chain)?;
    Ok(StealthMeta {
        spend_pub: m.spend_pub,
        view_pub: m.view_pub,
        meta: m.meta,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StealthSendOut {
    stealth_address: String,
    ephemeral_pub: String,
    view_tag: u8,
}

/// Sender side: derive a fresh one-time stealth address + announcement data for
/// a recipient's published (spendPub, viewPub). Needs no vault state.
#[tauri::command]
pub fn stealth_send_compute(
    spend_pub: String,
    view_pub: String,
) -> Result<StealthSendOut, String> {
    let s = stealth::sender_compute(&spend_pub, &view_pub)?;
    Ok(StealthSendOut {
        stealth_address: s.stealth_address,
        ephemeral_pub: s.ephemeral_pub,
        view_tag: s.view_tag,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    ephemeral_pub: String,
    view_tag: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StealthMatch {
    ephemeral_pub: String,
    stealth_address: String,
}

/// Recipient side: scan announcements with the viewing key and return the ones
/// that resolve to this account (with their one-time stealth address).
#[tauri::command]
pub fn stealth_scan(
    state: State<VaultState>,
    index: u32,
    announcements: Vec<Announcement>,
) -> Result<Vec<StealthMatch>, String> {
    let guard = state.0.lock().unwrap();
    let u = guard.as_ref().ok_or("vault is locked")?;
    let key = account_key_bytes(u, index)?;
    let mut out = Vec::new();
    for a in &announcements {
        if let Some(addr) = stealth::scan_one(&key, &a.ephemeral_pub, a.view_tag)? {
            out.push(StealthMatch {
                ephemeral_pub: a.ephemeral_pub.clone(),
                stealth_address: addr,
            });
        }
    }
    Ok(out)
}

/// Recipient side: sign a 32-byte digest with the one-time key for a discovered
/// stealth payment (used to sweep the funds out). The key never leaves Rust.
#[tauri::command]
pub fn stealth_sign(
    state: State<VaultState>,
    index: u32,
    ephemeral_pub: String,
    hash: String,
) -> Result<String, String> {
    let digest = hex::decode(hash.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    if digest.len() != 32 {
        return Err("hash must be 32 bytes".into());
    }
    let guard = state.0.lock().unwrap();
    let u = guard.as_ref().ok_or("vault is locked")?;
    let key = account_key_bytes(u, index)?;
    let otk = stealth::stealth_private_key(&key, &ephemeral_pub)?;
    let sk = signing_key_from_bytes(&otk)?;
    let (sig, recid): (Signature, RecoveryId) = sk
        .sign_prehash_recoverable(&digest)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(65);
    out.extend_from_slice(&sig.to_bytes());
    out.push(27 + recid.to_byte());
    Ok(format!("0x{}", hex::encode(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Standard BIP44 Ethereum derivation must match every other wallet, or
    // imported funds would appear missing. Vectors are the well-known Hardhat
    // test mnemonic (also verifies the EIP-55 checksum casing).
    #[test]
    fn derives_standard_eth_addresses() {
        let m = "test test test test test test test test test test test junk";
        let seed = mnemonic_to_seed(m).unwrap();
        assert_eq!(
            account_at(&seed, 0).unwrap().address,
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        );
        assert_eq!(
            account_at(&seed, 1).unwrap().address,
            "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
        );
    }

    // A sealed mnemonic must round-trip with the right password and fail with
    // the wrong one.
    #[test]
    fn seal_unseal_roundtrip() {
        let m = "test test test test test test test test test test test junk";
        let file = seal("hunter2", m, 1).unwrap();
        assert_eq!(unseal("hunter2", &file).unwrap().as_str(), m);
        assert!(unseal("wrong", &file).is_err());
    }
}
