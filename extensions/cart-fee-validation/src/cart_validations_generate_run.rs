use std::collections::{HashMap, HashSet};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use shopify_function::prelude::*;
use shopify_function::Result;

use crate::schema;

type HmacSha256 = Hmac<Sha256>;

#[derive(Deserialize)]
struct TokenPayload {
    #[allow(dead_code)]
    shop: String,
    sid: String,
    #[allow(dead_code)]
    p: i64,
    #[allow(dead_code)]
    c: String,
    #[allow(dead_code)]
    exp: i64,
    #[allow(dead_code)]
    iat: i64,
    mode: Option<String>,
}

#[derive(Deserialize)]
struct PriceMapEntry {
    sid: String,
    token: String,
}

const BLOCK_MESSAGE: &str =
    "Upload pricing is incomplete. Remove this item and add it again from the product page.";

#[shopify_function]
fn cart_validations_generate_run(
    input: schema::cart_validations_generate_run::Input,
) -> Result<schema::CartValidationsGenerateRunResult> {
    let mut errors = Vec::new();

    let hmac_key_str = input
        .shop()
        .shop_hmac()
        .as_ref()
        .map(|m| m.value().trim())
        .filter(|s| !s.is_empty());

    let price_map = merge_price_maps(
        input
            .cart()
            .price_map_legacy()
            .as_ref()
            .and_then(|a| a.value())
            .map(|s| s.as_str()),
        input
            .cart()
            .price_map()
            .as_ref()
            .and_then(|a| a.value())
            .map(|s| s.as_str()),
    );

    let mut artwork_by_session: HashMap<String, i64> = HashMap::new();
    let mut fee_by_session: HashMap<String, i64> = HashMap::new();

    for line in input.cart().lines() {
        let qty: i64 = (*line.quantity()).into();

        if let Some(session_attr) = line.session_token() {
            if let Some(session_str) = session_attr.value() {
                let sid = session_str.trim();
                if !sid.is_empty() {
                    artwork_by_session.insert(sid.to_string(), qty);
                }
            }
        }

        if let Some(fee_attr) = line.fee_for() {
            if let Some(fee_str) = fee_attr.value() {
                let sid = fee_str.trim();
                if !sid.is_empty() {
                    fee_by_session.insert(sid.to_string(), qty);
                }
            }
        }
    }

    // Symmetric pairing: orphan fee lines always block.
    for (sid, fee_qty) in &fee_by_session {
        match artwork_by_session.get(sid) {
            None => {
                errors.push(validation_error(BLOCK_MESSAGE));
                let _ = (sid, fee_qty);
            }
            Some(art_qty) if *art_qty != *fee_qty => {
                errors.push(validation_error(
                    "Upload fee quantity must match the product quantity.",
                ));
            }
            _ => {}
        }
    }

  // Build B only: verified token mode === buildB requires a fee line.
    if let Some(hmac_key) = hmac_key_str {
        let hmac_key_bytes = hmac_key.as_bytes();
        let mut checked_build_b: HashSet<String> = HashSet::new();

        for (sid, token_raw) in &price_map {
            if checked_build_b.contains(sid) {
                continue;
            }
            checked_build_b.insert(sid.clone());

            let Some(payload) = verify_price_token(token_raw, hmac_key_bytes) else {
                continue;
            };
            if payload.sid != *sid {
                continue;
            }
            if payload.mode.as_deref() != Some("buildB") {
                continue;
            }

            if !fee_by_session.contains_key(sid) {
                errors.push(validation_error(BLOCK_MESSAGE));
            } else if let Some(art_qty) = artwork_by_session.get(sid) {
                if fee_by_session.get(sid) != Some(art_qty) {
                    errors.push(validation_error(
                        "Upload fee quantity must match the product quantity.",
                    ));
                }
            }
        }
    }

    let mut operations = Vec::new();
    if !errors.is_empty() {
        operations.push(schema::Operation::ValidationAdd(schema::ValidationAddOperation {
            errors,
        }));
    }

    Ok(schema::CartValidationsGenerateRunResult { operations })
}

fn validation_error(message: &str) -> schema::ValidationError {
    schema::ValidationError {
        message: message.to_owned(),
        target: "$.cart".to_owned(),
    }
}

fn merge_price_maps(legacy: Option<&str>, primary: Option<&str>) -> HashMap<String, String> {
    let mut out = parse_price_map(legacy);
    for (k, v) in parse_price_map(primary) {
        out.insert(k, v);
    }
    out
}

fn parse_price_map(raw: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(raw_json) = raw else {
        return out;
    };
    let Ok(entries) = serde_json::from_str::<Vec<PriceMapEntry>>(raw_json) else {
        return out;
    };
    for entry in entries {
        let sid = entry.sid.trim();
        let token = entry.token.trim();
        if sid.is_empty() || token.is_empty() {
            continue;
        }
        out.insert(sid.to_string(), token.to_string());
    }
    out
}

fn verify_price_token(token: &str, hmac_key: &[u8]) -> Option<TokenPayload> {
    let mut parts = token.split('.');
    let header_part = parts.next()?;
    let payload_part = parts.next()?;
    let sig_part = parts.next()?;
    if parts.next().is_some() {
        return None;
    }

    let mut mac = HmacSha256::new_from_slice(hmac_key).ok()?;
    mac.update(header_part.as_bytes());
    mac.update(b".");
    mac.update(payload_part.as_bytes());
    let expected = mac.finalize().into_bytes();

    let actual = B64_URL.decode(sig_part).ok()?;
    if expected.as_slice().len() != actual.len() {
        return None;
    }
    if !constant_time_eq(expected.as_slice(), &actual) {
        return None;
    }

    let payload_bytes = B64_URL.decode(payload_part).ok()?;
    serde_json::from_slice::<TokenPayload>(&payload_bytes).ok()
}

#[inline]
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    a.ct_eq(b).into()
}
