#!/usr/bin/env python3
"""Mint an App Store Connect API JWT (ES256) for setup-testflight-secrets.sh.

ASC requires an ES256 JWT whose signature is the RAW R||S concatenation
(64 bytes: 32-byte R + 32-byte S, big-endian, zero-padded) base64url-encoded.
`openssl dgst -sha256 -sign` emits a DER-encoded ECDSA signature instead, and
the asn1parse/xxd shell conversion mishandles short/sign-bit integers ~1/256 of
the time (→ intermittent 401 on every ASC call). The `cryptography` library's
decode_dss_signature is the only correct, deterministic path — so this helper is
a hard dependency of the setup script (preflight gates on `import cryptography`).

Reads the .p8 path / key id / issuer id from the environment so the key bytes
and the minted token never appear in argv (which would land in shell history /
process listings). Prints ONLY the compact JWT to stdout.

  ASC_API_KEY_PATH  absolute path to AuthKey_XXXXXXXXXX.p8 (PKCS#8 PEM EC P-256)
  ASC_API_KEY_ID    10-char Key ID  → JWT `kid` header
  ASC_API_ISSUER_ID issuer UUID     → JWT `iss` claim
  ASC_JWT_TTL       optional, seconds (default 1140; ASC hard cap is 1200/20min)
"""

import base64
import json
import os
import sys
import time

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
except ImportError:  # pragma: no cover - preflight gates on this
    sys.stderr.write(
        "asc-jwt: the python3 'cryptography' module is required "
        "(pip3 install cryptography)\n"
    )
    sys.exit(2)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def main() -> int:
    key_path = os.environ.get("ASC_API_KEY_PATH", "")
    key_id = os.environ.get("ASC_API_KEY_ID", "")
    issuer_id = os.environ.get("ASC_API_ISSUER_ID", "")
    if not key_path or not key_id or not issuer_id:
        sys.stderr.write(
            "asc-jwt: ASC_API_KEY_PATH, ASC_API_KEY_ID, ASC_API_ISSUER_ID "
            "must all be set\n"
        )
        return 2

    try:
        ttl = int(os.environ.get("ASC_JWT_TTL", "1140"))
    except ValueError:
        ttl = 1140
    ttl = max(60, min(ttl, 1200))  # ASC rejects exp > iat + 1200s

    with open(key_path, "rb") as fh:
        key = serialization.load_pem_private_key(fh.read(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        sys.stderr.write("asc-jwt: .p8 is not an EC private key\n")
        return 2

    now = int(time.time())
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    # `aud` is fixed; `scope` is omitted on purpose — a full-access team key
    # applies to every provisioning endpoint the script calls, and omitting
    # scope keeps the 20-minute exp cap (scoped GET-only keys can go longer).
    payload = {"iss": issuer_id, "iat": now, "exp": now + ttl, "aud": "appstoreconnect-v1"}

    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64url(json.dumps(payload, separators=(",", ":")).encode())
    )

    der_sig = key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_sig)
    raw_sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")

    sys.stdout.write(signing_input + "." + _b64url(raw_sig))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
