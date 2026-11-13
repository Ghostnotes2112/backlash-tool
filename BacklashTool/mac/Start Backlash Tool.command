#!/bin/bash
# Double-click to start the Backlash Tool on macOS. Needs Node.js (nodejs.org).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin/node /opt/homebrew/bin/node; do [ -x "$p" ] && NODE="$p"; done
else
  NODE="$(command -v node)"
fi
if [ -z "$NODE" ]; then
  echo "Node.js is not installed. Get the LTS installer from https://nodejs.org, then double-click this again."
  read -r -p "Press Return to close."
  exit 1
fi
"$NODE" backlash-tool.cjs
