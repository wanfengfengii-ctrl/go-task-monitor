#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export GO_PIPELINE_PROJECT_GENERATOR_PROVIDER="codex"
export GO_PIPELINE_PROJECT_GENERATOR_EFFORT="${GO_PIPELINE_PROJECT_GENERATOR_EFFORT:-high}"
export GO_PIPELINE_BUGFIX_MODEL="${GO_PIPELINE_BUGFIX_MODEL:-model_hub/glm-52-coding}"
export GO_PIPELINE_REPAIR_WORKER_LIMIT="${GO_PIPELINE_REPAIR_WORKER_LIMIT:-6}"

cd "$project_root"
api_port="${GO_TASK_MONITOR_API_PORT:-4174}"
if curl -fsS --max-time 2 "http://127.0.0.1:${api_port}/api/system/health" >/dev/null 2>&1; then
  echo "Go task monitor API 已在线：http://127.0.0.1:${api_port}"
  exit 0
fi
exec node server.mjs
