#!/usr/bin/env bash
# Required package scripts: format:check, lint, typecheck, test:coverage.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for script_name in format:check lint typecheck test:coverage; do
  "${script_dir}/require-npm-script.sh" "$script_name"
  npm run "$script_name"
done
