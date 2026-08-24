#!/bin/bash
# import-credentials.sh — zero-config credential pickup for teammates.
#
# Teammates receive a personal `botboy-credentials.env` (two lines: OAuth
# client id + secret) via an expiring link. Instead of hand-editing dotfiles,
# they just download it and run ./start.sh — this script, invoked by the
# launcher on every start, finds the newest botboy-credentials*.env in
# ~/Downloads or ~/Desktop, merges the two credential lines into
# ~/.personal-productivity-tracker/.env (0600), and deletes the downloaded
# copy so the secret doesn't linger in Downloads.
#
# Re-running with a newer downloaded file REPLACES the stored credentials —
# so a rotation is: download the new file, restart BotBoy. No file found is
# a silent no-op (owner machines and already-configured teammates).
set -euo pipefail

ENV_DIR="$HOME/.personal-productivity-tracker"
ENV_FILE="$ENV_DIR/.env"
ID_KEY="BOTBOY_INFERENCE_OAUTH_CLIENT_ID"
SECRET_KEY="BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET"

# Newest botboy-credentials* file across the usual download spots. Any
# suffix is accepted (browsers rename: "botboy-credentials (1).env", Safari
# can append ".txt", Slack downloads keep the original name) — safe because
# the two expected keys are content-validated below before anything is
# imported.
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

# Extract exactly the two expected keys — ignore anything else in the file.
NEW_ID=$(grep "^$ID_KEY=" "$CANDIDATE" | head -1 || true)
NEW_SECRET=$(grep "^$SECRET_KEY=" "$CANDIDATE" | head -1 || true)
if [ -z "$NEW_ID" ] || [ -z "$NEW_SECRET" ]; then
  echo "⚠️  Found $CANDIDATE but it is missing $ID_KEY/$SECRET_KEY — not imported"
  exit 0
fi

umask 077
mkdir -p "$ENV_DIR"
TMP_FILE="$ENV_DIR/.env.import.$$"
# Keep every non-credential line the user already has; swap in the new pair.
if [ -f "$ENV_FILE" ]; then
  grep -v "^$ID_KEY=" "$ENV_FILE" | grep -v "^$SECRET_KEY=" > "$TMP_FILE" || true
else
  : > "$TMP_FILE"
fi
printf '%s\n%s\n' "$NEW_ID" "$NEW_SECRET" >> "$TMP_FILE"
mv "$TMP_FILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"
rm -f "$CANDIDATE"

echo "✅ Imported BotBoy credentials from $(basename "$CANDIDATE") into ~/.personal-productivity-tracker/.env (downloaded copy removed)"
