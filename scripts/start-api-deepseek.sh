#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
keychain_service="${GO_PIPELINE_DEEPSEEK_KEYCHAIN_SERVICE:-go-task-monitor.deepseek-project-generator}"
keychain_account="${GO_PIPELINE_DEEPSEEK_KEYCHAIN_ACCOUNT:-${USER:-go-task-monitor}}"
generator_token="${GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN:-}"

if [[ -z "$generator_token" ]]; then
  generator_token="$(security find-generic-password -a "$keychain_account" -s "$keychain_service" -w 2>/dev/null || true)"
fi
if [[ -z "$generator_token" ]]; then
  echo "DeepSeek 项目生成 Key 未配置。请先把 Key 写入 macOS 钥匙串服务：$keychain_service" >&2
  exit 1
fi

export GO_PIPELINE_PROJECT_GENERATOR_PROVIDER="deepseek"
export GO_PIPELINE_PROJECT_GENERATOR_BASE_URL="${GO_PIPELINE_PROJECT_GENERATOR_BASE_URL:-https://api.deepseek.com/anthropic}"
export GO_PIPELINE_PROJECT_GENERATOR_MODEL="${GO_PIPELINE_PROJECT_GENERATOR_MODEL:-deepseek-v4-pro[1m]}"
export GO_PIPELINE_PROJECT_GENERATOR_SUBAGENT_MODEL="${GO_PIPELINE_PROJECT_GENERATOR_SUBAGENT_MODEL:-deepseek-v4-flash}"
export GO_PIPELINE_PROJECT_GENERATOR_EFFORT="${GO_PIPELINE_PROJECT_GENERATOR_EFFORT:-low}"
export GO_PIPELINE_BUGFIX_MODEL="${GO_PIPELINE_BUGFIX_MODEL:-model_hub/glm-52-coding}"
export GO_PIPELINE_REPAIR_WORKER_LIMIT="${GO_PIPELINE_REPAIR_WORKER_LIMIT:-4}"
export GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN="$generator_token"
unset generator_token

cd "$project_root"
# Reuse the already running monitor instead of spawning a second listener.
# This keeps launch agents/retry loops from turning a healthy API into a
# stream of EADDRINUSE exits while preserving the configured port override.
api_port="${GO_TASK_MONITOR_API_PORT:-4174}"
if curl -fsS --max-time 2 "http://127.0.0.1:${api_port}/api/system/health" >/dev/null 2>&1; then
  echo "Go task monitor API 已在线：http://127.0.0.1:${api_port}"
  exit 0
fi
exec node server.mjs
