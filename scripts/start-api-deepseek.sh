#!/usr/bin/env bash
set -euo pipefail

# Retained so older local commands keep working after project generation moved
# from the DeepSeek Claude-compatible endpoint to Codex CLI.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start-api-codex.sh" "$@"
