#!/usr/bin/env bash
# Required package script: fixtures:validate. It must render deterministic, sanitized fixtures and assert their output.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"${script_dir}/require-npm-script.sh" fixtures:validate
npm run fixtures:validate
