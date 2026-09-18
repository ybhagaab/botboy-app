#!/bin/bash
# import-credentials.sh — zero-config credential pickup for teammates.
#
# The owner sends a personal `botboy-credentials.env` or an owner-created ZIP
# containing exactly that file in a 1:1 Slack DM. The teammate downloads it to
# ~/Downloads or ~/Desktop and runs ./start.sh. This script validates the two
# expected OAuth keys, atomically replaces only those keys in
# ~/.personal-productivity-tracker/.env (0600), and deletes the downloaded
# attachment after a successful import.
#
# No file found is a silent no-op (owner machines and configured teammates).
set -euo pipefail

ENV_DIR="$HOME/.personal-productivity-tracker"
ENV_FILE="$ENV_DIR/.env"
ID_KEY="BOTBOY_INFERENCE_OAUTH_CLIENT_ID"
SECRET_KEY="BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET"

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

# Require exactly one non-empty value for each key. Extra source lines are
# ignored; only these two allowlisted values can enter the stored environment.
ID_COUNT=$(grep -c "^$ID_KEY=" "$SOURCE" 2>/dev/null || true)
SECRET_COUNT=$(grep -c "^$SECRET_KEY=" "$SOURCE" 2>/dev/null || true)
NEW_ID=$(grep "^$ID_KEY=" "$SOURCE" 2>/dev/null | head -1 || true)
NEW_SECRET=$(grep "^$SECRET_KEY=" "$SOURCE" 2>/dev/null | head -1 || true)
# Tolerate a CRLF-saved two-line file without persisting carriage returns.
NEW_ID="${NEW_ID%$'\r'}"
NEW_SECRET="${NEW_SECRET%$'\r'}"
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
mv "$TMP_FILE" "$ENV_FILE"
TMP_FILE=""
chmod 600 "$ENV_FILE"
rm -f "$CANDIDATE"

SOURCE_KIND="file"
case "$CANDIDATE" in *.zip|*.ZIP) SOURCE_KIND="ZIP" ;; esac
echo "✅ Imported BotBoy credentials from $SOURCE_KIND $(basename "$CANDIDATE") into ~/.personal-productivity-tracker/.env (downloaded attachment removed)"
