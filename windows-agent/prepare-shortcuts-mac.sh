#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This step must run on macOS because Apple Shortcut signing uses /usr/bin/shortcuts." >&2
  exit 1
fi

python3 tools/build_windows_shortcuts.py

echo
echo "Windows shortcut templates are ready:"
ls -lh windows-agent/resources/shortcuts/*.shortcut
