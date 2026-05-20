use std::process;
use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use shopify_function::prelude::*;
use shopify_function::Result;

#[typegen("./schema.graphql")]
pub mod schema {
    #[query("./src/run.graphql")]
    pub mod cart_transform_run {}
}

type HmacSha256 = Hmac<Sha256>;

/// JWT body our app's price-token signer emits. Keep this in sync with
/// `app/services/price-token.server.ts` on the Node side.
#[derive(Deserialize)]
struct TokenPayload {
    #[allow(dead_code)]
    shop: String,
    #[allow(dead_code)]
    sid: String,
    /// Price in *minor units* (e.g. cents). Always positive.
    p: i64,
    /// ISO-4217 currency code. We use it only for decimal placement.
    c: String,
    #[allow(dead_code)]
    exp: i64,
    #[allow(dead_code)]
    iat: i64,
    #[serde(default)]
    mode: Option<String>,
}

const FEE_LINE_EXPAND_TITLE: &str = "Artwork upload fee";
const BUILD_A_EXPAND_TITLE_DEFAULT: &str = "Upload file";

/// Build A (default): expand lines with `_uc_session` to the signed total (base + upload fee).
/// Build B (legacy in-flight carts only): when any line has `_pd_fee_for`, expand fee lines only.

#[derive(Deserialize)]
struct PriceMapEntry {
    sid: String,
    token: String,
    #[serde(default, rename = "partOfTitle")]
    part_of_title: Option<String>,
    #[serde(default)]
    artwork: Option<String>,
}

#[shopify_function]
fn cart_transform_run(
    input: schema::cart_transform_run::Input,
) -> Result<schema::CartTransformRunResult> {
    let no_changes = schema::CartTransformRunResult { operations: vec![] };

    let hmac_key_str = input
        .cart_transform()
        .pricing_hmac()
        .as_ref()
        .map(|m| m.value().trim())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            input
                .shop()
                .shop_hmac()
                .as_ref()
                .map(|m| m.value().trim())
                .filter(|s| !s.is_empty())
        });

    let Some(hmac_key) = hmac_key_str else {
        return Ok(no_changes);
    };
    let hmac_key_bytes = hmac_key.as_bytes();
    let price_map_raw = merge_price_maps(
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
    let part_of_titles = part_of_titles_from_maps(
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
    let artwork_by_session = artwork_from_maps(
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
    let price_map: HashMap<String, String> = price_map_raw;

    let uses_fee_lines = input.cart().lines().iter().any(|line| {
        line.fee_for()
            .as_ref()
            .and_then(|a| a.value())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    });

    let mut operations: Vec<schema::Operation> = Vec::new();

    for line in input.cart().lines() {
        if line.selling_plan_allocation().is_some() {
            continue;
        }

        let session_id = if uses_fee_lines {
            let Some(fee_for_attr) = line.fee_for() else {
                continue;
            };
            let Some(fee_for_str) = fee_for_attr.value() else {
                continue;
            };
            let fee_for = fee_for_str.trim();
            if fee_for.is_empty() {
                continue;
            }
            fee_for
        } else {
            let Some(session_attr) = line.session_token() else {
                continue;
            };
            let Some(session_str) = session_attr.value() else {
                continue;
            };
            let session_id = session_str.trim();
            if session_id.is_empty() {
                continue;
            }
            session_id
        };

        let Some(token_raw) = price_map.get(session_id) else {
            continue;
        };
        if token_raw.is_empty() {
            continue;
        }

        let Some(payload) = verify_price_token(token_raw, hmac_key_bytes) else {
            continue;
        };
        if payload.sid != session_id {
            continue;
        };

        let variant_id = match line.merchandise() {
            schema::cart_transform_run::input::cart::lines::Merchandise::ProductVariant(pv) => {
                pv.id().to_string()
            }
            _ => continue,
        };

        let qty_raw: i64 = (*line.quantity()).into();
        let qty: i32 = qty_raw.max(1).min(i32::MAX as i64) as i32;
        let amount = price_minor_to_f64(payload.p, &payload.c);

        let expand_title = if uses_fee_lines {
            Some(FEE_LINE_EXPAND_TITLE.to_string())
        } else {
            let from_map = part_of_titles
                .get(session_id)
                .cloned()
                .filter(|s| !s.is_empty());
            Some(
                from_map.unwrap_or_else(|| BUILD_A_EXPAND_TITLE_DEFAULT.to_string()),
            )
        };

        let expanded_attributes = if uses_fee_lines {
            None
        } else {
            let component_attrs =
                build_part_of_component_attributes(line, session_id, &artwork_by_session);
            if component_attrs.is_empty() {
                None
            } else {
                Some(component_attrs)
            }
        };

        operations.push(schema::Operation::LineExpand(schema::LineExpandOperation {
            cart_line_id: line.id().to_string(),
            expanded_cart_items: vec![schema::ExpandedItem {
                attributes: expanded_attributes,
                merchandise_id: variant_id,
                price: Some(schema::ExpandedItemPriceAdjustment {
                    adjustment: schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(
                        schema::ExpandedItemFixedPricePerUnitAdjustment {
                            amount: amount.into(),
                        },
                    ),
                }),
                quantity: qty,
            }],
            image: None,
            price: None,
            title: expand_title,
        }));
    }

    if operations.is_empty() {
        return Ok(no_changes);
    }
    Ok(schema::CartTransformRunResult { operations })
}

/// Attributes for the expanded (Part of) component only. `__View uploads` stays on the
/// parent cart line so Admin shows the truncated link above Part of (Upload Center parity).
fn build_part_of_component_attributes(
    line: &schema::cart_transform_run::input::cart::Lines,
    session_id: &str,
    artwork_by_session: &HashMap<String, String>,
) -> Vec<schema::AttributeOutput> {
    let mut out: Vec<schema::AttributeOutput> = Vec::new();
    let view_uploads = line
        .view_uploads()
        .as_ref()
        .and_then(|a| a.value().map(|s| s.as_str()))
        .or_else(|| {
            line.view_uploads_link()
                .as_ref()
                .and_then(|a| a.value().map(|s| s.as_str()))
        });
    push_trimmed_attr(&mut out, "View uploads", view_uploads);
    let artwork = artwork_by_session
        .get(session_id)
        .map(|s| s.as_str())
        .or_else(|| {
            line.artwork()
                .as_ref()
                .and_then(|a| a.value().map(|s| s.as_str()))
        });
    push_trimmed_attr(&mut out, "Artwork", artwork);
    push_trimmed_attr(
        &mut out,
        "_uc_session",
        line.session_token()
            .as_ref()
            .and_then(|a| a.value().map(|s| s.as_str())),
    );
    out
}

fn push_trimmed_attr(out: &mut Vec<schema::AttributeOutput>, key: &str, value: Option<&str>) {
    let Some(trimmed) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    out.push(schema::AttributeOutput {
        key: key.to_string(),
        value: trimmed.to_string(),
    });
}

fn merge_price_maps(legacy: Option<&str>, primary: Option<&str>) -> HashMap<String, String> {
    let mut out = parse_price_map(legacy);
    for (k, v) in parse_price_map(primary) {
        out.insert(k, v);
    }
    out
}

fn part_of_titles_from_maps(legacy: Option<&str>, primary: Option<&str>) -> HashMap<String, String> {
    let mut out = parse_part_of_titles(legacy);
    for (k, v) in parse_part_of_titles(primary) {
        out.insert(k, v);
    }
    out
}

fn artwork_from_maps(legacy: Option<&str>, primary: Option<&str>) -> HashMap<String, String> {
    let mut out = parse_artwork_by_session(legacy);
    for (k, v) in parse_artwork_by_session(primary) {
        out.insert(k, v);
    }
    out
}

fn parse_artwork_by_session(raw: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(raw_json) = raw else {
        return out;
    };
    let Ok(entries) = serde_json::from_str::<Vec<PriceMapEntry>>(raw_json) else {
        return out;
    };
    for entry in entries {
        let sid = entry.sid.trim();
        if sid.is_empty() {
            continue;
        }
        if let Some(label) = entry
            .artwork
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            out.insert(sid.to_string(), label.to_string());
        }
    }
    out
}

fn parse_part_of_titles(raw: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(raw_json) = raw else {
        return out;
    };
    let Ok(entries) = serde_json::from_str::<Vec<PriceMapEntry>>(raw_json) else {
        return out;
    };
    for entry in entries {
        let sid = entry.sid.trim();
        if sid.is_empty() {
            continue;
        }
        if let Some(title) = entry
            .part_of_title
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            out.insert(sid.to_string(), title.to_string());
        }
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

/// Returns the decoded payload iff the JWT's HMAC-SHA256 signature is valid.
///
/// Expiration is *not* checked here. The Cart Transform input does not expose a
/// raw clock (only boolean comparisons on `shop.localTime`), and the
/// order/create webhook re-verifies `exp` server-side with a real wall clock.
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

/// Converts a price in minor units into a Decimal-compatible f64.
///
/// Shopify's `Decimal` scalar serializes to a JSON string so the f64 only acts
/// as an exact carrier for the small magnitudes we deal with (cart line
/// amounts, well under 2^53). The schema clamps to the currency's natural
/// decimal places downstream, so we don't need to format the string ourselves.
fn price_minor_to_f64(amount_minor: i64, currency: &str) -> f64 {
    let decimals = currency_decimals(currency);
    if decimals == 0 {
        return amount_minor as f64;
    }
    let scale: f64 = 10_f64.powi(decimals as i32);
    (amount_minor as f64) / scale
}

fn currency_decimals(currency: &str) -> usize {
    let mut buf = [0u8; 4];
    let len = currency.len().min(4);
    for (i, b) in currency.as_bytes().iter().take(len).enumerate() {
        buf[i] = b.to_ascii_uppercase();
    }
    let upper = std::str::from_utf8(&buf[..len]).unwrap_or("");

    match upper {
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "MGA" | "PYG" | "RWF" | "UGX"
        | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        _ => 2,
    }
}

fn main() {
    log!("Invoke a named export");
    process::abort()
}
