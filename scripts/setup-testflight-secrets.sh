#!/usr/bin/env bash
#
# setup-testflight-secrets.sh — provision ALL TestFlight signing material for the
# 5 Apple platforms (iOS / iPadOS / macOS / visionOS / watchOS) via the
# App Store Connect REST API, with NO fastlane, and register the resulting
# GitHub Actions secrets that .github/workflows/testflight.yml consumes.
#
# Apple-official tooling only (openssl + curl + gh + python3), matching ADR-0004
# / docs/testflight-setup.md (the by-hand fallback). Run this LOCALLY on macOS;
# it never uploads anything to TestFlight itself — it only fills the secrets so a
# `v*` tag push (or `gh workflow run testflight.yml`) does the upload.
#
# What it does (idempotent, safe to re-run):
#   1. Mints an ASC JWT (ES256) — see scripts/asc-jwt.py.
#   2. Issues distribution certificates from openssl-generated RSA keys+CSRs,
#      downloads the signed cert, assembles a password-protected .p12 LOCALLY.
#        - iOS Apple Distribution  (shared by iOS/iPadOS/visionOS/watchOS)
#        - Mac App Distribution    (macOS .app)
#        - Mac Installer Distribution (macOS .pkg)  — separate cert type
#   3. Ensures the App Store bundle IDs exist (GET-filter, POST-if-missing).
#   4. Creates App Store provisioning profiles per platform (delete+recreate).
#        visionOS/watchOS use profileType=IOS_APP_STORE against IOS-platform
#        bundle IDs — the exact thing fastlane `sigh` cannot do.
#   5. base64-encodes the .p12s and registers ~13 secrets via `gh secret set`
#      (profile secrets are registered VERBATIM — ASC already returns base64).
#
# State (generated keys / certs / .p12s / password / manifest) is persisted under
# a gitignored work dir so re-runs REUSE certs (Apple caps active distribution
# certs at ~2-3 per type) instead of minting a fresh one each time.
#
# MANUAL PREREQUISITES (this script CANNOT do them):
#   - Issue a *TEAM* ASC API key (.p8): ASC → Users and Access → Integrations →
#     App Store Connect API → "+", role App Manager or higher. INDIVIDUAL keys
#     cannot call the provisioning endpoints — the script will 403 on everything.
#   - Create the per-platform ASC APP RECORDS by hand (App records are NOT
#     API-creatable). Needed: dev.tpmt.app (iOS record — may reuse the old Expo
#     record), dev.tpmt.app (macOS record), dev.tpmt.app (visionOS record),
#     dev.tpmt.app.watch (iOS record — standalone watch ships under an iOS app
#     record). The script provisions bundle IDs + profiles; the app records must
#     pre-exist or the later TestFlight upload has nowhere to land.
#
# Usage:
#   ASC_API_KEY_PATH=~/AuthKey_ABCDE12345.p8 \
#   ASC_API_KEY_ID=ABCDE12345 \
#   ASC_API_ISSUER_ID=00000000-0000-0000-0000-000000000000 \
#   APPLE_TEAM_ID=MU784AJZSW \
#     scripts/setup-testflight-secrets.sh [--dry-run] [--no-secrets]
#                                         [--separate-installer] [--platforms ...]
#
# Flags:
#   --dry-run             do all reads but no ASC mutations and no `gh secret set`
#   --no-secrets          do all ASC work + assemble artifacts, skip gh secret set
#   --separate-installer  emit the Mac Installer identity as its own
#                         MAC_INSTALLER_CERT_P12_BASE64 secret instead of bundling
#                         it into MAC_DIST_CERT_P12_BASE64 (this is the DEFAULT —
#                         see note below). Pass --combined-installer to bundle.
#   --combined-installer  bundle both Mac certs into one MAC_DIST_CERT_P12_BASE64
#   --platforms "ios macos visionos watchos"  restrict which platforms to do
#                         (default: all)
#
set -euo pipefail

# ── constants ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JWT_HELPER="$SCRIPT_DIR/asc-jwt.py"
ASC_BASE="https://api.appstoreconnect.apple.com/v1"

WORK_DIR="${TP_TESTFLIGHT_DIR:-$HOME/.config/teleprompter/testflight}"
MANIFEST="$WORK_DIR/manifest.json"

# Canonical bundle IDs (ios/project.yml — verified at HEAD).
BID_APP="dev.tpmt.app"
BID_WATCH_CONTAINER="dev.tpmt.app.watch"
BID_WATCH_APP="dev.tpmt.app.watch.watchkitapp"

# Default installer layout: SEPARATE. The combined-PEM single-.p12 path works but
# is fragile (the obvious `openssl pkcs12 -export` with multiple -in/-inkey
# SILENTLY keeps only the last key/cert pair on openssl 3 — verified), so the
# safe default is two single-identity .p12s. --combined-installer opts into the
# combined-PEM path (with a 2-private-key assertion).
INSTALLER_LAYOUT="separate"
DRY_RUN=0
NO_SECRETS=0
PLATFORMS="ios macos visionos watchos"

# ── logging (never prints secret values) ─────────────────────────────────────
log()  { printf '\033[1;34m▸\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── arg parsing ──────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)            DRY_RUN=1 ;;
    --no-secrets)         NO_SECRETS=1 ;;
    --separate-installer) INSTALLER_LAYOUT="separate" ;;
    --combined-installer) INSTALLER_LAYOUT="combined" ;;
    --platforms)          shift; PLATFORMS="${1:-}" ;;
    -h|--help)            grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                    die "unknown flag: $1 (try --help)" ;;
  esac
  shift
done

has_platform() { case " $PLATFORMS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ── preflight ────────────────────────────────────────────────────────────────
preflight() {
  [ "$(uname)" = "Darwin" ] || die "must run on macOS (security/codesign tooling)"
  for tool in openssl curl gh python3 base64 plutil; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
  done
  [ -f "$JWT_HELPER" ] || die "missing JWT helper: $JWT_HELPER"
  # ES256 raw R||S is ONLY correct via python cryptography (must-fix #3).
  python3 -c 'import cryptography' 2>/dev/null \
    || die "python3 'cryptography' module required (pip3 install cryptography)"

  : "${ASC_API_KEY_PATH:?set ASC_API_KEY_PATH to the AuthKey_XXXX.p8 path}"
  : "${ASC_API_KEY_ID:?set ASC_API_KEY_ID (10-char Key ID)}"
  : "${ASC_API_ISSUER_ID:?set ASC_API_ISSUER_ID (issuer UUID)}"
  : "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (10-char Team ID, e.g. MU784AJZSW)}"
  [ -f "$ASC_API_KEY_PATH" ] || die "ASC_API_KEY_PATH not found: $ASC_API_KEY_PATH"

  if [ "$NO_SECRETS" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)"
  fi

  mkdir -p "$WORK_DIR"; chmod 700 "$WORK_DIR"
  [ -f "$MANIFEST" ] || echo '{}' > "$MANIFEST"

  # P12 password: always non-empty (must-fix #2 — passwordless openssl .p12 fails
  # macOS `security import`). Persist so reused .p12s keep a stable password.
  local pwfile="$WORK_DIR/p12_password"
  if [ -f "$pwfile" ]; then
    P12_PASSWORD="$(cat "$pwfile")"
  else
    P12_PASSWORD="${P12_PASSWORD:-$(openssl rand -base64 18)}"
    [ -n "$P12_PASSWORD" ] || die "refusing empty P12_PASSWORD (security import would reject it)"
    printf '%s' "$P12_PASSWORD" > "$pwfile"; chmod 600 "$pwfile"
  fi

  ok "preflight ok — work dir $WORK_DIR (gitignored), team $APPLE_TEAM_ID"
  [ "$DRY_RUN" -eq 1 ] && warn "DRY RUN — no ASC mutations, no secrets written"
}

# ── ASC REST helpers (mint a fresh JWT per call; never crosses the 20m cap) ───
_jwt() {
  ASC_API_KEY_PATH="$ASC_API_KEY_PATH" ASC_API_KEY_ID="$ASC_API_KEY_ID" \
  ASC_API_ISSUER_ID="$ASC_API_ISSUER_ID" python3 "$JWT_HELPER"
}

# asc <METHOD> <path> [json-body-file] → writes JSON to stdout, http code to fd3.
# Sets global ASC_HTTP to the status code; returns nonzero only on transport err.
asc() {
  local method="$1" path="$2" body="${3:-}" jwt
  jwt="$(_jwt)" || die "failed to mint ASC JWT"
  local args=(-sS -X "$method" "$ASC_BASE$path"
    -H "Authorization: Bearer $jwt" -H "Content-Type: application/json"
    -w '\n%{http_code}')
  [ -n "$body" ] && args+=(-d "@$body")
  local out; out="$(curl "${args[@]}")" || die "curl transport error on $method $path"
  ASC_HTTP="${out##*$'\n'}"
  printf '%s' "${out%$'\n'*}"
}

# jq-free JSON field extraction via python (python3 is a hard dep already).
json_get() { python3 -c 'import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

# ── certificate issuance ─────────────────────────────────────────────────────
# ensure_cert <CERT_TYPE> <slug> → assembles $WORK_DIR/<slug>.p12 (reuse-aware).
# Reuse REQUIRES the local private key (ASC never returns it) AND the manifest's
# recorded cert still being listed on ASC. On 409 (team cap) we print + instruct
# revoke — never auto-revoke, never blind-retry (must-fix #5).
ensure_cert() {
  local ctype="$1" slug="$2"
  local key="$WORK_DIR/${slug}_key.pem" der="$WORK_DIR/${slug}.cer"
  local pem="$WORK_DIR/${slug}.pem" p12="$WORK_DIR/${slug}.p12" csr="$WORK_DIR/${slug}.csr"
  local recorded_id; recorded_id="$(json_get "json.load(open('$MANIFEST')).get('cert_${slug}','')" 2>/dev/null || true)"

  if [ -f "$key" ] && [ -f "$p12" ] && [ -n "$recorded_id" ]; then
    local listing; listing="$(asc GET "/certificates?filter%5BcertificateType%5D=$ctype&limit=200")"
    if [ "$ASC_HTTP" = "200" ] && printf '%s' "$listing" | grep -q "\"$recorded_id\""; then
      ok "cert $ctype: reusing existing (id ${recorded_id:0:8}…, local key present)"
      return 0
    fi
    warn "cert $ctype: local key present but recorded cert not on ASC — re-issuing"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then warn "cert $ctype: DRY RUN — would generate key+CSR and POST"; return 0; fi

  log "cert $ctype: generating RSA-2048 key + CSR (Apple CA rejects EC CSRs)"
  openssl req -new -newkey rsa:2048 -nodes -keyout "$key" -out "$csr" \
    -subj "/CN=Teleprompter $ctype/O=$APPLE_TEAM_ID" >/dev/null 2>&1
  chmod 600 "$key"

  # Build the create body with python so the PEM CSR newlines are JSON-escaped.
  local bodyfile="$WORK_DIR/.${slug}_create.json"
  python3 - "$csr" "$ctype" > "$bodyfile" <<'PY'
import json, sys
csr = open(sys.argv[1]).read()
print(json.dumps({"data": {"type": "certificates",
    "attributes": {"certificateType": sys.argv[2], "csrContent": csr}}}))
PY
  local resp; resp="$(asc POST "/certificates" "$bodyfile")"; rm -f "$bodyfile"

  if [ "$ASC_HTTP" = "409" ] || [ "$ASC_HTTP" = "403" ]; then
    warn "cert $ctype: ASC returned $ASC_HTTP — likely the active-cert cap for this type."
    local existing; existing="$(asc GET "/certificates?filter%5BcertificateType%5D=$ctype&limit=200")"
    printf '%s\n' "$existing" | python3 -c '
import sys,json
for c in json.load(sys.stdin).get("data",[]):
    a=c["attributes"]; print(f"   - {c[\"id\"]}  {a.get(\"name\",\"\")}  exp {a.get(\"expirationDate\",\"\")}")' >&2 || true
    die "Revoke an existing $ctype cert in the Developer portal, then re-run. (A cert whose private key you don't hold locally is unusable for a .p12.)"
  fi
  [ "$ASC_HTTP" = "201" ] || die "cert $ctype: create failed (HTTP $ASC_HTTP): $(printf '%s' "$resp" | head -c 400)"

  local cert_id content
  cert_id="$(printf '%s' "$resp" | json_get "d['data']['id']" 2>/dev/null \
    || printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')"
  content="$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["attributes"]["certificateContent"])')"
  printf '%s' "$content" | base64 --decode > "$der"
  openssl x509 -inform DER -in "$der" -out "$pem" >/dev/null 2>&1
  openssl pkcs12 -export -inkey "$key" -in "$pem" -out "$p12" -passout "pass:$P12_PASSWORD" >/dev/null 2>&1

  manifest_set "cert_${slug}" "$cert_id"
  ok "cert $ctype: issued + assembled $slug.p12 (id ${cert_id:0:8}…)"
}

# Combine Mac App + Mac Installer identities into ONE .p12 via combined-PEM ONLY
# (must-fix #1: multiple -in/-inkey silently drops all but the last pair).
assemble_combined_mac_p12() {
  local out="$WORK_DIR/mac_dist.p12"
  local combined="$WORK_DIR/.mac_combined.pem"
  cat "$WORK_DIR/mac_app_key.pem" "$WORK_DIR/mac_app.pem" \
      "$WORK_DIR/mac_installer_key.pem" "$WORK_DIR/mac_installer.pem" > "$combined"
  openssl pkcs12 -export -in "$combined" -out "$out" -passout "pass:$P12_PASSWORD" >/dev/null 2>&1
  rm -f "$combined"
  local n; n="$(openssl pkcs12 -info -in "$out" -passin "pass:$P12_PASSWORD" -nodes 2>/dev/null | grep -c 'BEGIN PRIVATE KEY' || true)"
  [ "$n" -eq 2 ] || die "combined mac .p12 has $n private keys (expected 2) — use --separate-installer"
  ok "combined mac .p12 assembled (2 identities verified)"
}

# ── bundle id ensure-exists ──────────────────────────────────────────────────
# ensure_bundle_id <identifier> <IOS|MAC_OS> <name> → echoes the ASC bundleId UUID.
ensure_bundle_id() {
  local ident="$1" plat="$2" name="$3"
  local found
  found="$(asc GET "/bundleIds?filter%5Bidentifier%5D=$ident&filter%5Bplatform%5D=$plat")"
  if [ "$ASC_HTTP" = "200" ]; then
    local id; id="$(printf '%s' "$found" | python3 -c '
import sys,json
d=json.load(sys.stdin).get("data",[])
print(d[0]["id"] if d else "")')"
    if [ -n "$id" ]; then ok "bundleId $ident ($plat): exists" >&2; printf '%s' "$id"; return 0; fi
  fi
  if [ "$DRY_RUN" -eq 1 ]; then warn "bundleId $ident ($plat): DRY RUN — would create" >&2; printf 'DRYRUN'; return 0; fi

  local bodyfile="$WORK_DIR/.bid_create.json"
  python3 - "$ident" "$plat" "$name" > "$bodyfile" <<'PY'
import json, sys
print(json.dumps({"data": {"type": "bundleIds",
    "attributes": {"identifier": sys.argv[1], "platform": sys.argv[2], "name": sys.argv[3]}}}))
PY
  local resp; resp="$(asc POST "/bundleIds" "$bodyfile")"; rm -f "$bodyfile"
  if [ "$ASC_HTTP" = "409" ]; then
    found="$(asc GET "/bundleIds?filter%5Bidentifier%5D=$ident&filter%5Bplatform%5D=$plat")"
    printf '%s' "$found" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])'
    ok "bundleId $ident ($plat): already registered (reused)" >&2; return 0
  fi
  [ "$ASC_HTTP" = "201" ] || die "bundleId $ident ($plat): create failed (HTTP $ASC_HTTP)"
  printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])'
  ok "bundleId $ident ($plat): created" >&2
}

# ── profile create (delete+recreate by name) ─────────────────────────────────
# create_profile <name> <PROFILE_TYPE> <bundleId-uuid> <cert-uuid> → echoes
# the profileContent (already base64 of the raw .mobileprovision — registered
# verbatim, NEVER re-base64'd: must-fix / double-encode guard).
create_profile() {
  local name="$1" ptype="$2" bid="$3" cert="$4"

  if [ "$DRY_RUN" -eq 1 ]; then warn "profile '$name' ($ptype): DRY RUN — would (re)create" >&2; printf 'DRYRUN'; return 0; fi

  # delete any existing profile of this type with our exact name (avoid 409).
  local existing; existing="$(asc GET "/profiles?filter%5BprofileType%5D=$ptype&limit=200")"
  printf '%s' "$existing" | python3 -c '
import sys,json
for p in json.load(sys.stdin).get("data",[]):
    if p["attributes"].get("name")==sys.argv[1]: print(p["id"])' "$name" | while read -r pid; do
    [ -n "$pid" ] && asc DELETE "/profiles/$pid" >/dev/null || true
  done

  local bodyfile="$WORK_DIR/.prof_create.json"
  python3 - "$name" "$ptype" "$bid" "$cert" > "$bodyfile" <<'PY'
import json, sys
name, ptype, bid, cert = sys.argv[1:5]
print(json.dumps({"data": {"type": "profiles",
    "attributes": {"name": name, "profileType": ptype},
    "relationships": {
        "bundleId": {"data": {"type": "bundleIds", "id": bid}},
        "certificates": {"data": [{"type": "certificates", "id": cert}]}}}}))
PY
  local resp; resp="$(asc POST "/profiles" "$bodyfile")"; rm -f "$bodyfile"
  if [ "$ASC_HTTP" != "201" ]; then
    warn "profile '$name' ($ptype): create FAILED (HTTP $ASC_HTTP): $(printf '%s' "$resp" | head -c 300)" >&2
    printf ''; return 1
  fi
  printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["attributes"]["profileContent"])'
}

# ── tiny manifest mutator ────────────────────────────────────────────────────
manifest_set() {
  local tmp; tmp="$(mktemp)"
  python3 -c '
import sys,json
d=json.load(open(sys.argv[1])); d[sys.argv[2]]=sys.argv[3]
json.dump(d, open(sys.argv[1],"w"))' "$MANIFEST" "$1" "$2" 2>/dev/null \
    && return 0
  # fallback when MANIFEST momentarily unreadable
  printf '{"%s":"%s"}' "$1" "$2" > "$MANIFEST"
  : "$tmp"
}

# ── secret registration ──────────────────────────────────────────────────────
# Tracks each secret's outcome for the final summary without printing values.
declare -a SUMMARY=()
set_file_secret() {  # name ← base64(file)
  local name="$1" file="$2"
  if [ "$NO_SECRETS" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then SUMMARY+=("$name → (skipped: $( [ "$DRY_RUN" -eq 1 ] && echo dry-run || echo no-secrets ))"); return 0; fi
  base64 -i "$file" | gh secret set "$name" >/dev/null && SUMMARY+=("$name ← base64($(basename "$file"))  [set]")
}
set_raw_secret() {   # name ← verbatim stdin (already-base64 profileContent)
  local name="$1" value="$2"
  if [ "$NO_SECRETS" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then SUMMARY+=("$name → (skipped)"); return 0; fi
  [ -n "$value" ] || { warn "$name: empty profileContent — NOT setting (platform job will skip)"; SUMMARY+=("$name → (empty, not set)"); return 0; }
  printf '%s' "$value" | gh secret set "$name" >/dev/null && SUMMARY+=("$name ← profileContent verbatim  [set]")
}
set_str_secret() {   # name ← plain string
  local name="$1" value="$2"
  if [ "$NO_SECRETS" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then SUMMARY+=("$name → (skipped)"); return 0; fi
  gh secret set "$name" -b "$value" >/dev/null && SUMMARY+=("$name ← (string)  [set]")
}

# ── main ─────────────────────────────────────────────────────────────────────
main() {
  preflight

  # Shared ASC secrets (all platforms).
  set_file_secret ASC_API_KEY_P8_BASE64 "$ASC_API_KEY_PATH"
  set_str_secret  ASC_API_KEY_ID    "$ASC_API_KEY_ID"
  set_str_secret  ASC_API_ISSUER_ID "$ASC_API_ISSUER_ID"
  set_str_secret  APPLE_TEAM_ID     "$APPLE_TEAM_ID"

  # Certificates. iOS Apple Distribution is shared by iOS/iPadOS/visionOS/watchOS.
  local need_ios_cert=0
  has_platform ios && need_ios_cert=1
  has_platform visionos && need_ios_cert=1
  has_platform watchos && need_ios_cert=1
  if [ "$need_ios_cert" -eq 1 ]; then
    ensure_cert IOS_DISTRIBUTION ios_dist
    set_file_secret IOS_DIST_CERT_P12_BASE64 "$WORK_DIR/ios_dist.p12"
    set_str_secret  IOS_DIST_CERT_PASSWORD "$P12_PASSWORD"
  fi

  if has_platform macos; then
    ensure_cert MAC_APP_DISTRIBUTION       mac_app
    ensure_cert MAC_INSTALLER_DISTRIBUTION mac_installer
    if [ "$INSTALLER_LAYOUT" = "combined" ]; then
      [ "$DRY_RUN" -eq 1 ] || assemble_combined_mac_p12
      set_file_secret MAC_DIST_CERT_P12_BASE64 "$WORK_DIR/mac_dist.p12"
      set_str_secret  MAC_DIST_CERT_PASSWORD "$P12_PASSWORD"
    else
      set_file_secret MAC_DIST_CERT_P12_BASE64      "$WORK_DIR/mac_app.p12"
      set_str_secret  MAC_DIST_CERT_PASSWORD        "$P12_PASSWORD"
      set_file_secret MAC_INSTALLER_CERT_P12_BASE64 "$WORK_DIR/mac_installer.p12"
      set_str_secret  MAC_INSTALLER_CERT_PASSWORD   "$P12_PASSWORD"
    fi
  fi

  # Resolve cert UUIDs from the manifest for profile relationships.
  local ios_cert_id mac_app_cert_id
  ios_cert_id="$(json_get "json.load(open('$MANIFEST')).get('cert_ios_dist','')" 2>/dev/null || true)"
  mac_app_cert_id="$(json_get "json.load(open('$MANIFEST')).get('cert_mac_app','')" 2>/dev/null || true)"

  # Bundle IDs + profiles.
  if has_platform ios; then
    local bid; bid="$(ensure_bundle_id "$BID_APP" IOS Teleprompter)"
    set_raw_secret IOS_PROVISIONING_PROFILE_BASE64 \
      "$(create_profile 'Teleprompter iOS App Store' IOS_APP_STORE "$bid" "$ios_cert_id" || true)"
  fi
  if has_platform visionos; then
    # IOS_APP_STORE against the IOS bundleId — the exact path sigh can't take.
    local bid; bid="$(ensure_bundle_id "$BID_APP" IOS Teleprompter)"
    set_raw_secret VISIONOS_PROVISIONING_PROFILE_BASE64 \
      "$(create_profile 'Teleprompter visionOS App Store' IOS_APP_STORE "$bid" "$ios_cert_id" || true)"
  fi
  if has_platform watchos; then
    local bidc bida
    bidc="$(ensure_bundle_id "$BID_WATCH_CONTAINER" IOS 'Teleprompter Watch Container')"
    bida="$(ensure_bundle_id "$BID_WATCH_APP" IOS 'Teleprompter Watch App')"
    set_raw_secret WATCHOS_CONTAINER_PROVISIONING_PROFILE_BASE64 \
      "$(create_profile 'Teleprompter watch container App Store' IOS_APP_STORE "$bidc" "$ios_cert_id" || true)"
    set_raw_secret WATCHOS_APP_PROVISIONING_PROFILE_BASE64 \
      "$(create_profile 'Teleprompter watch app App Store' IOS_APP_STORE "$bida" "$ios_cert_id" || true)"
  fi
  if has_platform macos; then
    local bid; bid="$(ensure_bundle_id "$BID_APP" MAC_OS Teleprompter)"
    set_raw_secret MAC_PROVISIONING_PROFILE_BASE64 \
      "$(create_profile 'Teleprompter macOS App Store' MAC_APP_STORE "$bid" "$mac_app_cert_id" || true)"
  fi

  # Summary (names + actions only — never values).
  printf '\n\033[1m── secret summary ─────────────────────────────\033[0m\n' >&2
  for line in "${SUMMARY[@]}"; do printf '   %s\n' "$line" >&2; done
  printf '\n' >&2
  ok "done. Re-run safely any time (certs reused, profiles recreated)."
  warn "Reminder: per-platform ASC APP RECORDS must exist (not API-creatable)."
  [ "$NO_SECRETS" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && \
    log "Next: gh workflow run testflight.yml   (or push a v* tag)"
}

main "$@"
