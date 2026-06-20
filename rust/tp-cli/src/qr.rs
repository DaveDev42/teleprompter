//! Terminal QR rendering for `tp pair new`.
//!
//! The Bun CLI uses `qrcode-terminal` with `{ small: true }`, which packs two
//! QR rows per text line using Unicode half-block glyphs. We render the same
//! "small" half-block style via the `qrcode` crate's `render::unicode::Dense1x2`
//! renderer.
//!
//! **Glyph divergence is intentional and accepted** (ADR-0003 Amendment 2,
//! tranche 3b): the exact module/border layout will NOT byte-match
//! `qrcode-terminal`. That is fine — the iOS scanner and copy-paste flow both
//! read the raw `tp://p?d=…` URL printed on the line BELOW the QR (pair.ts:170),
//! which is byte-identical because it comes verbatim from the daemon's
//! `pair.begin.ok.qrString`. The QR glyphs are a visual convenience only.

use qrcode::render::unicode::Dense1x2;
use qrcode::QrCode;

/// Render `data` as a small (half-block) terminal QR string.
///
/// On the (practically impossible for a `tp://` URL) error path where the QR
/// encoder rejects the input, returns an empty string so the caller still
/// prints the raw URL line below. The data we feed is always a short ASCII
/// `tp://p?d=<base64url>` deep link, well within QR capacity.
pub fn render_qr_small(data: &str) -> String {
    match QrCode::new(data.as_bytes()) {
        Ok(code) => code
            .render::<Dense1x2>()
            .dark_color(Dense1x2::Light)
            .light_color(Dense1x2::Dark)
            .build(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_non_empty_for_pairing_url() {
        let url = "tp://p?d=dHAYA0FCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla";
        let out = render_qr_small(url);
        assert!(!out.is_empty(), "QR render must produce a non-empty string");
        // Half-block renderer emits Unicode block glyphs and newlines.
        assert!(out.contains('\n'), "expected multi-line QR output");
    }

    #[test]
    fn renders_non_empty_for_short_input() {
        let out = render_qr_small("x");
        assert!(!out.is_empty());
    }
}
