#!/usr/bin/env bash
# Manual itch.io publish (local). CI does this automatically on push to main
# (.github/workflows/deploy-itch.yml); use this for a one-off push from your machine.
#
# Usage:
#   ITCH_USER=<your-itch-username> \
#   BUTLER_API_KEY=<key from itch.io/user/settings/api-keys> \
#   BUTLER="C:/Users/ngson/butler/butler.exe" \
#   npm run deploy:itch
#
# Defaults: ITCH_GAME=slim3d, CHANNEL=html5, BUTLER=butler (must be on PATH).
set -euo pipefail

: "${ITCH_USER:?Set ITCH_USER to your itch.io username}"
ITCH_GAME="${ITCH_GAME:-slime-and-stuff}"
CHANNEL="${CHANNEL:-html5}"
BUTLER="${BUTLER:-butler}"

echo "Building..."
npx vite build

echo "Pushing dist/ -> $ITCH_USER/$ITCH_GAME:$CHANNEL"
"$BUTLER" push dist "$ITCH_USER/$ITCH_GAME:$CHANNEL" --userversion "$(git rev-parse --short HEAD)"
echo "Done. On the itch.io page, ensure the build is marked 'This file will be played in the browser'."
