#!/usr/bin/env bash
# Fails with an actionable message when the root package contract is incomplete.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <npm-script>" >&2
  exit 64
fi

script_name="$1"

if [[ ! -f package.json ]]; then
  echo "CI contract error: package.json is required before CI can run." >&2
  exit 1
fi

if ! node -e '
const fs = require("node:fs");
const name = process.argv[1];
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
process.exit(Object.hasOwn(pkg.scripts ?? {}, name) ? 0 : 1);
' "$script_name"; then
  echo "CI contract error: package.json must define script \"${script_name}\"." >&2
  exit 1
fi
