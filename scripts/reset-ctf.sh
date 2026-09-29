#!/usr/bin/env bash
# Full CTF reset: stop everything, wipe team databases + scores, remove networks.
# Warning: irreversible — all team progress and solve history is deleted.
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose -f docker-compose.ctf.yml down -v --remove-orphans

echo "CTF stack fully reset (volumes wiped)."
echo "Regenerate configs if team list changed: node scripts/gen-ctf.js --teams <N>"
echo "Start again: docker compose -f docker-compose.ctf.yml up --build -d"