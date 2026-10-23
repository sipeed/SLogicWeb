#!/usr/bin/env bash
# Purge slogic.sipeed.com's unhashed URLs from the Qiniu CDN after a Pages deploy,
# then prove a Qiniu edge serves this build byte-for-byte.
#
# Why this exists:
#   - In mainland China slogic.sipeed.com is a CNAME to Qiniu, which pulls from GitHub
#     Pages and keeps what it pulled long past the origin's max-age=600. Without a purge,
#     every warmed edge keeps serving the previous index.html.
#   - Every asset URL carries a content hash (Vite chunks, pyodide/<hash>/,
#     decoders-<hash>.zip, the OTA pages' ?v=<hash> stamps), so purging the unhashed
#     paths below is enough: a fresh HTML page pulls only fresh asset URLs. A new
#     unhashed file in dist/ (anything not named by content hash) belongs in PATHS.
#   - `/` and `/index.html` (and `/ota/`, `/ota/index.html`) are separate cache entries.
#   - The edge keeps an identity and a gzip variant (Vary: Accept-Encoding) apart; a purge
#     that cleared one but not the other has been seen on other Sipeed sites, so both are
#     checked.
#
# Usage: purge-qiniu-cdn.sh <dist-dir>
# Env:   QINIU_ACCESS_KEY, QINIU_SECRET_KEY (repository secrets). When unset - e.g. on a
#        fork - the purge is skipped with a warning instead of failing the run.
#
# Exit status: non-zero when Qiniu rejects the purge or no edge serves this build within
# the timeout. The Pages deploy has already succeeded by then; a red job here means
# "mainland visitors may still see the previous build", nothing more.
set -euo pipefail

DIST=${1:?usage: purge-qiniu-cdn.sh <dist-dir>}
SITE=https://slogic.sipeed.com
# Target of the default (mainland) DNS line; the overseas line goes straight to Pages.
QINIU_CNAME=slogic-sipeed-com-idvs37w.qiniudns.com
PATHS=(/ /index.html /favicon.svg /DEPLOY.txt /LICENSE.txt /THIRD_PARTY_LICENSES.txt /ota/ /ota/index.html /ota/batch.html /ota/favicon.svg /ota/firmware.json)
# Qiniu documents purges as taking effect within minutes; resubmit once halfway through.
TIMEOUT=600
RESUBMIT_AFTER=300
INTERVAL=20

if [[ -z ${QINIU_ACCESS_KEY:-} || -z ${QINIU_SECRET_KEY:-} ]]; then
  echo "::warning::QINIU_ACCESS_KEY / QINIU_SECRET_KEY are not set - skipping the CDN purge."
  exit 0
fi

# The file in dist/ that a URL path serves.
local_file() {
  case $1 in
    */) echo "$DIST$1index.html" ;;
    *) echo "$DIST$1" ;;
  esac
}

for path in "${PATHS[@]}"; do
  [[ -f $(local_file "$path") ]] || { echo "::error::$(local_file "$path") is missing from the build"; exit 1; }
done

# POST /v2/tune/refresh with a QBox token. The signed string is "<path>\n" only: the
# JSON body is NOT signed (Qiniu signs the body for x-www-form-urlencoded only), and
# signing it anyway yields a steady 401.
purge() {
  local api=/v2/tune/refresh sign body resp
  sign=$(printf '%s\n' "$api" | openssl dgst -sha1 -hmac "$QINIU_SECRET_KEY" -binary | openssl base64 -A | tr '+/' '-_')
  body=$(printf '%s\n' "$@" | jq -R . | jq -sc '{urls: .}')
  resp=$(curl -sS --max-time 30 -X POST "https://fusion.qiniuapi.com$api" \
    -H "Authorization: QBox $QINIU_ACCESS_KEY:$sign" \
    -H 'Content-Type: application/json' \
    -d "$body")
  echo "purge response: $resp"
  if [[ $(jq -r '.code' <<<"$resp" 2>/dev/null) != 200 ]]; then
    echo "::error::Qiniu rejected the purge request"
    return 1
  fi
}

# Pin one edge so every check below talks to the same node.
EDGE=$(dig +short "$QINIU_CNAME" A | grep -E '^[0-9.]+$' | head -n1)
[[ -n $EDGE ]] || { echo "::error::$QINIU_CNAME does not resolve to an A record"; exit 1; }
echo "checking against Qiniu edge $EDGE"

# Prints the paths whose identity or gzip response from the edge differs from dist/.
stale_paths() {
  local path want got_plain got_gzip
  for path in "${PATHS[@]}"; do
    want=$(sha256sum "$(local_file "$path")" | cut -d' ' -f1)
    got_plain=$(curl -sS --max-time 60 --resolve "slogic.sipeed.com:443:$EDGE" "$SITE$path" | sha256sum | cut -d' ' -f1) || true
    got_gzip=$(curl -sS --max-time 60 --compressed --resolve "slogic.sipeed.com:443:$EDGE" "$SITE$path" | sha256sum | cut -d' ' -f1) || true
    [[ $got_plain == "$want" && $got_gzip == "$want" ]] || echo "$path"
  done
}

urls=()
for path in "${PATHS[@]}"; do urls+=("$SITE$path"); done
purge "${urls[@]}"

start=$SECONDS
resubmitted=
while :; do
  sleep "$INTERVAL"
  mapfile -t stale < <(stale_paths)
  if (( ${#stale[@]} == 0 )); then
    echo "edge $EDGE serves this build for all ${#PATHS[@]} paths ($((SECONDS - start))s)"
    break
  fi
  echo "still stale after $((SECONDS - start))s: ${stale[*]}"
  if (( SECONDS - start >= TIMEOUT )); then
    echo "::error::Qiniu edge $EDGE still serves an old copy of: ${stale[*]}"
    exit 1
  fi
  if [[ -z $resubmitted ]] && (( SECONDS - start >= RESUBMIT_AFTER )); then
    urls=()
    for path in "${stale[@]}"; do urls+=("$SITE$path"); done
    purge "${urls[@]}"
    resubmitted=1
  fi
done

{
  echo '### CDN: Qiniu purge'
  echo
  echo "Purged and verified on edge \`$EDGE\` (identity + gzip):"
  echo
  for path in "${PATHS[@]}"; do echo "- $SITE$path"; done
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
