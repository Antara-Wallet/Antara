//! Stealth addresses (ERC-5564, secp256k1) for private receiving.
//!
//! A recipient has two key pairs, both derived from the vault seed so the
//! recovery phrase restores everything:
//!   - spending  (m, M=m*G): only this can SPEND received funds.
//!   - viewing   (v, V=v*G): can DETECT received funds but not spend them.
//! The pair (M, V) is published as a "stealth meta-address".
//!
//! To pay the recipient, a sender picks a random ephemeral key (r, R=r*G) and
//! derives a fresh one-time stealth address:
//!   shared  = r*V                     (ECDH; recipient recomputes it as v*R)
//!   s_h     = keccak256(compress(shared))
//!   P       = M + s_h*G               (stealth public key)
//!   address = keccak(P)[12..]
//! The sender funds `address` and announces (R, view_tag = s_h[0]).
//!
//! The recipient scans announcements with the viewing key (v*R == r*V), checks
//! the 1-byte view tag for a fast skip, recomputes P, and matches the address.
//! To spend, it derives the one-time private key p = (m + s_h) mod n, whose
//! public key is exactly P. Nothing on-chain links the address back to M/V.
//!
//! All point/scalar math stays in this Rust process; the webview only ever sees
//! public keys and addresses.

use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::{Field, PrimeField};
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar, U256};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

/// Domain separator so the viewing key is independent of any other use of the
/// spending key, yet deterministic from it (hence recoverable from the seed).
const VIEW_DOMAIN: &[u8] = b"ARK:stealth:view:v1";

fn scalar_from_bytes(b: &[u8; 32]) -> Result<Scalar, String> {
    let s = Scalar::from_repr(*FieldBytes::from_slice(b));
    if bool::from(s.is_some()) {
        Ok(s.unwrap())
    } else {
        Err("invalid scalar".into())
    }
}

/// Parse a hex-encoded SEC1 public key (compressed 33B or uncompressed 65B).
fn point_from_hex(h: &str) -> Result<ProjectivePoint, String> {
    let bytes = hex::decode(h.trim().trim_start_matches("0x")).map_err(|e| e.to_string())?;
    let ep = EncodedPoint::from_bytes(&bytes).map_err(|_| "bad public key".to_string())?;
    let aff = AffinePoint::from_encoded_point(&ep);
    if bool::from(aff.is_some()) {
        Ok(ProjectivePoint::from(aff.unwrap()))
    } else {
        Err("public key is not on the curve".into())
    }
}

fn compressed_hex(p: &ProjectivePoint) -> String {
    let enc = p.to_affine().to_encoded_point(true);
    format!("0x{}", hex::encode(enc.as_bytes()))
}

/// EIP-55 checksummed address from 20 raw bytes.
fn checksum_address(raw: &[u8]) -> String {
    let lower = hex::encode(raw);
    let hash = Keccak256::digest(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, ch) in lower.chars().enumerate() {
        if ch.is_ascii_digit() {
            out.push(ch);
        } else {
            let nibble = (hash[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0x0f;
            if nibble >= 8 {
                out.push(ch.to_ascii_uppercase());
            } else {
                out.push(ch);
            }
        }
    }
    out
}

/// Ethereum address of a public-key point.
fn address_of_point(p: &ProjectivePoint) -> String {
    let enc = p.to_affine().to_encoded_point(false); // 0x04 || X || Y
    let hash = Keccak256::digest(&enc.as_bytes()[1..]);
    checksum_address(&hash[12..32])
}

/// Viewing scalar = keccak256(domain || m) reduced mod n. Deterministic from the
/// spending key, so both keys come back from the recovery phrase.
fn viewing_scalar(spend: &Scalar) -> Scalar {
    let mut h = Keccak256::new();
    h.update(VIEW_DOMAIN);
    h.update(spend.to_bytes());
    let d = h.finalize();
    <Scalar as Reduce<U256>>::reduce_bytes(FieldBytes::from_slice(&d))
}

/// From a shared-secret point: (s_h scalar, view tag byte).
fn shared_to_scalar_and_tag(shared: &ProjectivePoint) -> (Scalar, u8) {
    let comp = shared.to_affine().to_encoded_point(true); // compressed
    let sh = Keccak256::digest(comp.as_bytes());
    let tag = sh[0];
    let scalar = <Scalar as Reduce<U256>>::reduce_bytes(FieldBytes::from_slice(&sh));
    (scalar, tag)
}

pub struct MetaAddress {
    pub spend_pub: String, // compressed hex
    pub view_pub: String,  // compressed hex
    pub meta: String,      // st:<chain>:0x<spendPub><viewPub>
}

/// Build the recipient's stealth meta-address from their spending private key.
pub fn meta_address(spend_key: &[u8; 32], chain_label: &str) -> Result<MetaAddress, String> {
    let m = scalar_from_bytes(spend_key)?;
    let v = viewing_scalar(&m);
    let big_m = ProjectivePoint::GENERATOR * m;
    let big_v = ProjectivePoint::GENERATOR * v;
    let spend_pub = compressed_hex(&big_m);
    let view_pub = compressed_hex(&big_v);
    let meta = format!("st:{}:0x{}{}", chain_label, &spend_pub[2..], &view_pub[2..]);
    Ok(MetaAddress {
        spend_pub,
        view_pub,
        meta,
    })
}

pub struct StealthSend {
    pub stealth_address: String,
    pub ephemeral_pub: String, // compressed hex (R)
    pub view_tag: u8,
}

/// Sender side: given the recipient's (spendPub, viewPub), pick a random
/// ephemeral key and derive a one-time stealth address + announcement data.
pub fn sender_compute(spend_pub: &str, view_pub: &str) -> Result<StealthSend, String> {
    let big_m = point_from_hex(spend_pub)?;
    let big_v = point_from_hex(view_pub)?;
    let r = Scalar::random(&mut rand::rngs::OsRng);
    let big_r = ProjectivePoint::GENERATOR * r;
    let shared = big_v * r;
    let (s_h, tag) = shared_to_scalar_and_tag(&shared);
    let stealth_pub = big_m + ProjectivePoint::GENERATOR * s_h;
    Ok(StealthSend {
        stealth_address: address_of_point(&stealth_pub),
        ephemeral_pub: compressed_hex(&big_r),
        view_tag: tag,
    })
}

/// Recipient side: does this announcement (ephemeral pub R, optional view tag)
/// belong to me? Returns the one-time stealth address if so.
pub fn scan_one(
    spend_key: &[u8; 32],
    ephemeral_pub: &str,
    view_tag: Option<u8>,
) -> Result<Option<String>, String> {
    let m = scalar_from_bytes(spend_key)?;
    let v = viewing_scalar(&m);
    let big_r = point_from_hex(ephemeral_pub)?;
    let shared = big_r * v;
    let (s_h, tag) = shared_to_scalar_and_tag(&shared);
    if let Some(t) = view_tag {
        if t != tag {
            return Ok(None); // fast reject via the 1-byte tag
        }
    }
    let big_m = ProjectivePoint::GENERATOR * m;
    let stealth_pub = big_m + ProjectivePoint::GENERATOR * s_h;
    Ok(Some(address_of_point(&stealth_pub)))
}

/// Recipient side: derive the one-time private key for a discovered payment so
/// the funds can be swept. p = (m + s_h) mod n.
pub fn stealth_private_key(
    spend_key: &[u8; 32],
    ephemeral_pub: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let m = scalar_from_bytes(spend_key)?;
    let v = viewing_scalar(&m);
    let big_r = point_from_hex(ephemeral_pub)?;
    let shared = big_r * v;
    let (s_h, _tag) = shared_to_scalar_and_tag(&shared);
    let p = m + s_h;
    let mut out = [0u8; 32];
    out.copy_from_slice(&p.to_bytes());
    Ok(Zeroizing::new(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(s: &str) -> [u8; 32] {
        let v = hex::decode(s).unwrap();
        let mut a = [0u8; 32];
        a.copy_from_slice(&v);
        a
    }

    // Address of a private key (via its public point) — independent re-derivation
    // used to confirm the swept key actually controls the stealth address.
    fn address_from_privkey(k: &[u8; 32]) -> String {
        let s = scalar_from_bytes(k).unwrap();
        address_of_point(&(ProjectivePoint::GENERATOR * s))
    }

    // The whole feature in one test: a sender derives a stealth address from the
    // published meta-address; the recipient independently finds the SAME address
    // by scanning, and the key they derive for it matches. No shared state.
    #[test]
    fn full_roundtrip() {
        // Hardhat account 0 private key as the spending key.
        let spend = hex32("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

        let meta = meta_address(&spend, "base").unwrap();
        assert!(meta.meta.starts_with("st:base:0x"));

        let send = sender_compute(&meta.spend_pub, &meta.view_pub).unwrap();

        // Recipient scans the announcement and lands on the same address.
        let found = scan_one(&spend, &send.ephemeral_pub, Some(send.view_tag)).unwrap();
        assert_eq!(found.as_deref(), Some(send.stealth_address.as_str()));

        // And the one-time key the recipient derives controls that address.
        let otk = stealth_private_key(&spend, &send.ephemeral_pub).unwrap();
        assert_eq!(address_from_privkey(&otk), send.stealth_address);
    }

    // Different ephemeral keys must yield different stealth addresses (unlinkable).
    #[test]
    fn payments_are_unlinkable() {
        let spend = hex32("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        let meta = meta_address(&spend, "base").unwrap();
        let a = sender_compute(&meta.spend_pub, &meta.view_pub).unwrap();
        let b = sender_compute(&meta.spend_pub, &meta.view_pub).unwrap();
        assert_ne!(a.stealth_address, b.stealth_address);
        assert_ne!(a.ephemeral_pub, b.ephemeral_pub);
    }

    // Someone else's spending key must NOT resolve to my stealth address.
    #[test]
    fn other_recipient_does_not_match() {
        let me = hex32("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        let other = hex32("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
        let meta = meta_address(&me, "base").unwrap();
        let send = sender_compute(&meta.spend_pub, &meta.view_pub).unwrap();
        let found = scan_one(&other, &send.ephemeral_pub, None).unwrap();
        assert_ne!(found.as_deref(), Some(send.stealth_address.as_str()));
    }
}
