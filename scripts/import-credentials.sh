#!/bin/bash
# import-credentials.sh — zero-config credential pickup for teammates.
#
# The owner sends a personal `botboy-credentials.env` or an owner-created ZIP
# containing exactly that file in a 1:1 Slack DM. The teammate downloads it to
# ~/Downloads or ~/Desktop and runs ./start.sh. The file carries one or both
# sections, each a KEY=value pair:
#   - BOTBOY_INFERENCE_OAUTH_CLIENT_ID/_SECRET (team AI gateway sign-in):
#     atomically replaces only those keys in ~/.personal-productivity-tracker/.env
#   - BOTBOY_GMAIL_OAUTH_CLIENT_ID/_SECRET lines from older files are skipped:
#     every install saves its own Google client in Connections → Gmail
#     (GMAIL_CHAT_TOOLS_PLAN.md D12), so nothing about Gmail is imported.
# The gateway section is validated before anything is written, and the
# downloaded attachment is deleted only after it is written.
#
# No file found is a silent no-op (owner machines and configured teammates).
set -euo pipefail

ENV_DIR="$HOME/.personal-productivity-tracker"
ENV_FILE="$ENV_DIR/.env"
ID_KEY="BOTBOY_INFERENCE_OAUTH_CLIENT_ID"
SECRET_KEY="BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET"
GMAIL_ID_KEY="BOTBOY_GMAIL_OAUTH_CLIENT_ID"
GMAIL_SECRET_KEY="BOTBOY_GMAIL_OAUTH_CLIENT_SECRET"

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
cleanup() {
  [ -z "$EXTRACTED_FILE" ] || rm -f "$EXTRACTED_FILE"
  [ -z "$TMP_FILE" ] || rm -f "$TMP_FILE"
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

# The gateway section needs exactly one non-empty value for both of its keys.
# Extra source lines are ignored; only these two values can leave the attachment.
key_count() { grep -c "^$1=" "$SOURCE" 2>/dev/null || true; }
key_line() {
  local line
  line=$(grep "^$1=" "$SOURCE" 2>/dev/null | head -1 || true)
  # Tolerate a CRLF-saved file without persisting carriage returns.
  printf '%s' "${line%$'\r'}"
}
ID_COUNT=$(key_count "$ID_KEY")
SECRET_COUNT=$(key_count "$SECRET_KEY")
GMAIL_LINES=$(( $(key_count "$GMAIL_ID_KEY") + $(key_count "$GMAIL_SECRET_KEY") ))
NEW_ID=$(key_line "$ID_KEY")
NEW_SECRET=$(key_line "$SECRET_KEY")
SOURCE_KIND="file"
case "$CANDIDATE" in *.zip|*.ZIP) SOURCE_KIND="ZIP" ;; esac
GMAIL_NOTE=""
[ "$GMAIL_LINES" = "0" ] || GMAIL_NOTE=" Its Gmail lines were skipped: Gmail uses your own Google client from Connections → Gmail."

if [ "$ID_COUNT" = "0" ] && [ "$SECRET_COUNT" = "0" ] && [ "$GMAIL_LINES" != "0" ]; then
  # An older Gmail-only file: BotBoy no longer reads it, and a credential
  # should not stay in Downloads.
  rm -f "$CANDIDATE"
  echo "ℹ️  Nothing to import from $SOURCE_KIND $(basename "$CANDIDATE"): it only carries a Google client, and Gmail now uses your own client from Connections → Gmail (downloaded attachment removed)"
  exit 0
fi
if [ "$ID_COUNT" != "1" ] || [ "$SECRET_COUNT" != "1" ] \
  || [ -z "${NEW_ID#*=}" ] || [ -z "${NEW_SECRET#*=}" ]; then
  echo "⚠️  Found $(basename "$CANDIDATE") but it does not contain one valid $ID_KEY/$SECRET_KEY pair — not imported"
  exit 0
fi

TMP_FILE="$ENV_DIR/.env.import.$$"
# Keep every non-credential line already present; replace only the OAuth pair.
if [ -f "$ENV_FILE" ]; then
  grep -v "^$ID_KEY=" "$ENV_FILE" | grep -v "^$SECRET_KEY=" > "$TMP_FILE" || true
else
  : > "$TMP_FILE"
fi
printf '%s\n%s\n' "$NEW_ID" "$NEW_SECRET" >> "$TMP_FILE"
# rename(2) replaces the path itself, never a file a planted link points to.
mv "$TMP_FILE" "$ENV_FILE"
TMP_FILE=""
chmod 600 "$ENV_FILE"
rm -f "$CANDIDATE"

echo "✅ Imported AI gateway sign-in into ~/.personal-productivity-tracker/.env from $SOURCE_KIND $(basename "$CANDIDATE") (downloaded attachment removed).$GMAIL_NOTE"
