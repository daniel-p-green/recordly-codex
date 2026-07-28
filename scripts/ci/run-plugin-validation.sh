#!/usr/bin/env bash
# Required package script: plugin:validate. It must validate the distributable plugin manifest and bundle.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"${script_dir}/require-npm-script.sh" plugin:validate
npm run plugin:validate
