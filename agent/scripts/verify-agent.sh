#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
package_dir="$(dirname -- "$script_dir")"
cd "$package_dir"

npm test
node --check src/cli.js
node --check src/runtime.js
node --check src/credentials.js
node --check scripts/smoke.mjs
node bin/tetris.js doctor --json

if [[ -n "${TETRIS_CREDENTIALS_FILE:-}" ]]; then
  if [[ ! -f "$TETRIS_CREDENTIALS_FILE" ]]; then
    printf 'TETRIS_CREDENTIALS_FILE does not name a file.\n' >&2
    exit 1
  fi
  npm run smoke
else
  config_home="${XDG_CONFIG_HOME:-${HOME:?HOME is required}/.config}"
  credentials_file="$config_home/tetris-agent/credentials.json"
  if [[ -f "$credentials_file" ]]; then
    npm run smoke
  else
    printf 'Codex network smoke skipped: run `tetris-agent login` to create Tetris credentials.\n'
  fi
fi
