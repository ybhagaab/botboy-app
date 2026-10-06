#!/bin/bash
# import-credentials.sh — zero-config credential pickup for teammates.
#
# The owner sends a personal `botboy-credentials.env` or an owner-created ZIP
# containing exactly that file in a 1:1 Slack DM. The teammate downloads it to
# ~/Downloads or ~/Desktop and runs ./start.sh. The file carries one or both
# sections, each a KEY=value pair:
#   - BOTBOY_INFERENCE_OAUTH_CLIENT_ID/_SECRET (team AI gateway sign-in):
#     atomically replaces only those keys in ~/.personal-productivity-tracker/.env
#   - BOTBOY_GMAIL_OAUTH_CLIENT_ID/_SECRET (BotBoy's shared Google client, so
#     Connections → Gmail is one Connect click): validated and staged in
#     ~/.personal-productivity-tracker/gmail-team-client.json; the server
#     applies it at its next boot and deletes it (never into .env: model-run
#     shells inherit the environment).
# Every section present is validated before anything is written, and the
# downloaded attachment is deleted only after every section is written.
#
# No file found is a silent no-op (owner machines and configured teammates).
set -euo pipefail

ENV_DIR="$HOME/.personal-productivity-tracker"
ENV_FILE="$ENV_DIR/.env"
ID_KEY="BOTBOY_INFERENCE_OAUTH_CLIENT_ID"
SECRET_KEY="BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET"
GMAIL_ID_KEY="BOTBOY_GMAIL_OAUTH_CLIENT_ID"
GMAIL_SECRET_KEY="BOTBOY_GMAIL_OAUTH_CLIENT_SECRET"
GMAIL_INBOX="$ENV_DIR/gmail-team-client.json"
# Same rules as gmail-credentials.ts › validateGmailClient. Only these JSON-safe
# characters can pass, so the staged file needs no escaping.
GMAIL_ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{4,200}\.apps\.googleusercontent\.com$'
GMAIL_SECRET_RE='^[A-Za-z0-9._~+/=-]{8,200}$'

# Newest botboy-credentials* file across the usual download spots. Slack and
# browsers may add suffixes. Content is validated before stored state changes.
CANDIDATE=""
CANDIDATE_MTIME=0
for f in "$HOME/Downloads"/botboy-credentials* "$HOME/Desktop"/botboy-credentials*; do
  [ -f "$f" ] || continue
  MTIME=$(stat -f %m "$f" 2>/dev/null || echo 0)
  if [ "$MTIME" -gt "$CANDIDATE_MTIME" ]; then
    CANDIDATE="$f"
    CANDIDATE_MTIME="$MTIME"
  fi
done
[ -n "$CANDIDATE" ] || exit 0

umask 077
mkdir -p "$ENV_DIR"
SOURCE="$CANDIDATE"
EXTRACTED_FILE=""
TMP_FILE=""
TMP_GMAIL=""
cleanup() {
  [ -z "$EXTRACTED_FILE" ] || rm -f "$EXTRACTED_FILE"
  [ -z "$TMP_FILE" ] || rm -f "$TMP_FILE"
  [ -z "$TMP_GMAIL" ] || rm -f "$TMP_GMAIL"
}
trap cleanup EXIT

# Automated delivery uses ZIP to prevent secret text from appearing in tool
# previews. Accept only one exact root member; never extract paths from an
# untrusted archive. The credential payload is intentionally tiny.
case "$CANDIDATE" in
  *.zip|*.ZIP)
    if [ ! -x /usr/bin/unzip ]; then
      echo "⚠️  Found $(basename "$CANDIDATE") but /usr/bin/unzip is unavailable — not imported"
      exit 0
    fi
    MEMBER_COUNT=$(/usr/bin/unzip -Z1 "$CANDIDATE" 2>/dev/null \
      | grep -c '^botboy-credentials\.env$' || true)
    if [ "$MEMBER_COUNT" != "1" ]; then
      echo "⚠️  Found $(basename "$CANDIDATE") but it must contain exactly one root botboy-credentials.env — not imported"
      exit 0
    fi
    EXTRACTED_FILE="$ENV_DIR/.credentials.import.$$"
    # Bound extraction before it reaches disk. PIPESTATUS preserves unzip's
    # CRC/status while head caps an oversized member at 4097 bytes for reject.
    set +e
    /usr/bin/unzip -p "$CANDIDATE" botboy-credentials.env 2>/dev/null \
      | /usr/bin/head -c 4097 > "$EXTRACTED_FILE"
    UNZIP_STATUS=${PIPESTATUS[0]}
    set -e
    EXTRACTED_SIZE=$(stat -f %z "$EXTRACTED_FILE" 2>/dev/null || echo 0)
    if [ "$UNZIP_STATUS" -ne 0 ] || [ "$EXTRACTED_SIZE" -le 0 ] \
      || [ "$EXTRACTED_SIZE" -gt 4096 ]; then
      echo "⚠️  Credential payload in $(basename "$CANDIDATE") is unreadable or has an unexpected size — not imported"
      exit 0
    fi
    chmod 600 "$EXTRACTED_FILE"
    SOURCE="$EXTRACTED_FILE"
    ;;
esac

# Each section is optional, but a present section needs exactly one non-empty
# value for both of its keys. Extra source lines are ignored; only these four
# allowlisted values can leave the attachment.
key_count() { grep -c "^$1=" "$SOURCE" 2>/dev/null || true; }
key_line() {
  local line
  line=$(grep "^$1=" "$SOURCE" 2>/dev/null | head -1 || true)
  # Tolerate a CRLF-saved file without persisting carriage returns.
  printf '%s' "${line%$'\r'}"
}
ID_COUNT=$(key_count "$ID_KEY")
SECRET_COUNT=$(key_count "$SECRET_KEY")
GMAIL_ID_COUNT=$(key_count "$GMAIL_ID_KEY")
GMAIL_SECRET_COUNT=$(key_count "$GMAIL_SECRET_KEY")
NEW_ID=$(key_line "$ID_KEY")
NEW_SECRET=$(key_line "$SECRET_KEY")
GMAIL_ID_LINE=$(key_line "$GMAIL_ID_KEY")
GMAIL_SECRET_LINE=$(key_line "$GMAIL_SECRET_KEY")
GMAIL_ID="${GMAIL_ID_LINE#*=}"
GMAIL_SECRET="${GMAIL_SECRET_LINE#*=}"

HAS_INFERENCE=0
if [ "$ID_COUNT" != "0" ] || [ "$SECRET_COUNT" != "0" ]; then
  if [ "$ID_COUNT" != "1" ] || [ "$SECRET_COUNT" != "1" ] \
    || [ -z "${NEW_ID#*=}" ] || [ -z "${NEW_SECRET#*=}" ]; then
    echo "⚠️  Found $(basename "$CANDIDATE") but it does not contain one valid $ID_KEY/$SECRET_KEY pair — not imported"
    exit 0
  fi
  HAS_INFERENCE=1
fi
HAS_GMAIL=0
if [ "$GMAIL_ID_COUNT" != "0" ] || [ "$GMAIL_SECRET_COUNT" != "0" ]; then
  if [ "$GMAIL_ID_COUNT" != "1" ] || [ "$GMAIL_SECRET_COUNT" != "1" ] \
    || ! [[ "$GMAIL_ID" =~ $GMAIL_ID_RE ]] || ! [[ "$GMAIL_SECRET" =~ $GMAIL_SECRET_RE ]]; then
    echo "⚠️  Found $(basename "$CANDIDATE") but its $GMAIL_ID_KEY/$GMAIL_SECRET_KEY pair is not one valid Google Desktop client — not imported"
    exit 0
  fi
  HAS_GMAIL=1
fi
if [ "$HAS_INFERENCE" = "0" ] && [ "$HAS_GMAIL" = "0" ]; then
  echo "⚠️  Found $(basename "$CANDIDATE") but it does not contain one valid $ID_KEY/$SECRET_KEY pair — not imported"
  exit 0
fi

IMPORTED=""
if [ "$HAS_INFERENCE" = "1" ]; then
  TMP_FILE="$ENV_DIR/.env.import.$$"
  # Keep every non-credential line already present; replace only the OAuth pair.
  if [ -f "$ENV_FILE" ]; then
    grep -v "^$ID_KEY=" "$ENV_FILE" | grep -v "^$SECRET_KEY=" > "$TMP_FILE" || true
  else
    : > "$TMP_FILE"
  fi
  printf '%s\n%s\n' "$NEW_ID" "$NEW_SECRET" >> "$TMP_FILE"
  mv "$TMP_FILE" "$ENV_FILE"
  TMP_FILE=""
  chmod 600 "$ENV_FILE"
  IMPORTED="AI gateway sign-in into ~/.personal-productivity-tracker/.env"
fi
if [ "$HAS_GMAIL" = "1" ]; then
  TMP_GMAIL="$ENV_DIR/.gmail-team-client.import.$$"
  printf '{\n  "schemaVersion": 1,\n  "clientId": "%s",\n  "clientSecret": "%s"\n}\n' "$GMAIL_ID" "$GMAIL_SECRET" > "$TMP_GMAIL"
  chmod 600 "$TMP_GMAIL"
  # rename(2) replaces the path itself, never a file a planted link points to.
  mv "$TMP_GMAIL" "$GMAIL_INBOX"
  TMP_GMAIL=""
  IMPORTED="${IMPORTED:+$IMPORTED and }BotBoy's Google client for Connections → Gmail (applied when BotBoy starts)"
fi
rm -f "$CANDIDATE"

SOURCE_KIND="file"
case "$CANDIDATE" in *.zip|*.ZIP) SOURCE_KIND="ZIP" ;; esac
echo "✅ Imported $IMPORTED from $SOURCE_KIND $(basename "$CANDIDATE") (downloaded attachment removed)"
