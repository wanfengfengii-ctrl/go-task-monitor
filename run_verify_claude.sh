#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 TASK_DIR PHASE SOURCE_DIR OUTPUT_DIR" >&2
  exit 2
fi

task_dir="$(cd "$1" && pwd)"
phase="$2"
source_dir="$(cd "$3" && pwd)"
output_dir="$4"
[[ "$phase" == "pre_fix" || "$phase" == "post_fix" ]] || { echo "phase must be pre_fix or post_fix" >&2; exit 2; }
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
[[ ! -e "$output_dir/manifest.json" ]] || { echo "verification proof already exists: $output_dir" >&2; exit 3; }

if [[ -n "${GO_PIPELINE_CLAUDE_BIN:-}" ]]; then
  claude_bin="$GO_PIPELINE_CLAUDE_BIN"
elif [[ "$(uname -s)" == "Darwin" && -x /Users/niuyuhang/.npm-global/bin/claude ]]; then
  claude_bin="/Users/niuyuhang/.npm-global/bin/claude"
elif command -v claude >/dev/null 2>&1; then
  claude_bin="$(command -v claude)"
else
  claude_bin="/Users/niuyuhang/.npm-global/bin/claude"
fi
runner_root="${GO_PIPELINE_MONITOR_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
result_extractor="$runner_root/scripts/extract-verification-results.mjs"
run_root="$(mktemp -d "${TMPDIR:-/tmp}/go-task-verify.XXXXXX")"
proof_root="$run_root/proof"
workspace="$proof_root/workspace"
grader="$proof_root/grader"
raw_stream="$run_root/raw.stream.jsonl"
stderr_log="$run_root/claude.stderr.log"
prompt_file="$run_root/PROMPT.md"
result_file="$proof_root/verification-result.json"
export CLAUDE_CONFIG_DIR="$run_root/claude-config"

cleanup() {
  chmod -R u+w "$run_root" 2>/dev/null || true
  rm -rf "$run_root" || true
}
trap cleanup EXIT

mkdir -p "$workspace" "$grader" "$CLAUDE_CONFIG_DIR"
rsync -a --delete --exclude='.git/' "$source_dir/" "$workspace/"
rsync -a --delete "$task_dir/grader/" "$grader/"
cp "$task_dir/public.json" "$proof_root/public.json"

jq -e '.verify_cmds | type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' "$proof_root/public.json" >/dev/null \
  || { echo "public.json verify_cmds must be a non-empty string array" >&2; exit 4; }
task_type="$(jq -r '.task_type // empty' "$proof_root/public.json")"
[[ "$task_type" == "bugfix" || "$task_type" == "diagnosis" ]] \
  || { echo "public.json task_type must be bugfix or diagnosis" >&2; exit 4; }

node "$runner_root/scripts/render-verification-prompt.mjs" "$phase" "$proof_root/public.json" >"$prompt_file"

claude_user_settings="$HOME/.claude/settings.json"
claude_model="${GO_PIPELINE_BUGFIX_MODEL:-model_hub/glm-52-coding}"
if [[ -r "$claude_user_settings" ]]; then
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    ANTHROPIC_API_KEY="$(jq -r '.env.ANTHROPIC_API_KEY // empty' "$claude_user_settings")"
    [[ -z "$ANTHROPIC_API_KEY" ]] || export ANTHROPIC_API_KEY
  fi
  if [[ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
    ANTHROPIC_AUTH_TOKEN="$(jq -r '.env.ANTHROPIC_AUTH_TOKEN // empty' "$claude_user_settings")"
    [[ -z "$ANTHROPIC_AUTH_TOKEN" ]] || export ANTHROPIC_AUTH_TOKEN
  fi
  if [[ -z "${ANTHROPIC_BASE_URL:-}" ]]; then
    ANTHROPIC_BASE_URL="$(jq -r '.env.ANTHROPIC_BASE_URL // empty' "$claude_user_settings")"
    [[ -z "$ANTHROPIC_BASE_URL" ]] || export ANTHROPIC_BASE_URL
  fi
  if [[ -z "${GO_PIPELINE_CLAUDE_GATEWAYS_JSON:-}" ]]; then
    GO_PIPELINE_CLAUDE_GATEWAYS_JSON="$(jq -rc '.env.GO_PIPELINE_CLAUDE_GATEWAYS_JSON // .goPipelineClaudeGateways // empty | if type == "string" then . else tojson end' "$claude_user_settings")"
    [[ -z "$GO_PIPELINE_CLAUDE_GATEWAYS_JSON" ]] || export GO_PIPELINE_CLAUDE_GATEWAYS_JSON
  fi
fi
gateway_selector="$runner_root/scripts/select-claude-gateway.mjs"
if [[ -n "${GO_PIPELINE_CLAUDE_GATEWAYS_JSON:-}" && -f "$gateway_selector" ]]; then
  selected_gateway="$(node "$gateway_selector" "$claude_model" "${ANTHROPIC_BASE_URL:-}")"
  if [[ -n "$selected_gateway" ]]; then
    ANTHROPIC_BASE_URL="$selected_gateway"
    export ANTHROPIC_BASE_URL
  fi
fi

# Verification must honor the repository's go.mod toolchain requirement. The
# host may have an older local Go (for example 1.23 while the task requires
# 1.25); forcing local would turn a valid post-fix test into a false red.
export GOTOOLCHAIN=auto
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
# Keep checksum verification enabled when Go auto-downloads the toolchain;
# GOSUMDB=off makes the toolchain module fail before the target test starts.
export GOSUMDB="${GOSUMDB:-sum.golang.org}"
export BASH_DEFAULT_TIMEOUT_MS="${BASH_DEFAULT_TIMEOUT_MS:-1800000}"
export BASH_MAX_TIMEOUT_MS="${BASH_MAX_TIMEOUT_MS:-1800000}"
verification_cache="$task_dir/.verification-cache"
mkdir -p "$verification_cache"
export GOCACHE="$verification_cache/gocache"
export GOMODCACHE="$verification_cache/gomodcache"
export GOTMPDIR="$run_root/gotmp"
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOTMPDIR"

has_docker_command="$(jq -r 'any(.verify_cmds[]; test("^docker[[:space:]]"; "i"))' "$proof_root/public.json")"
proof_workdir="$proof_root"
# Packaged Docker proofs resolve workspace/ and grader/ from the proof root;
# direct Go commands run inside the copied workspace.
if [[ "$has_docker_command" != "true" ]]; then
  test_overlay="$(jq -r '.verification_test_overlay // "none"' "$proof_root/public.json")"
  case "$test_overlay" in
    private-fixture)
      fixture_dir="$(jq -r '.verification_fixture_dir // empty' "$proof_root/public.json")"
      fixture_file="$(jq -r '.verification_test_files[0] // empty' "$proof_root/public.json")"
      task_root="$(cd "$task_dir" && pwd)"
      fixture_dir="$(cd "$fixture_dir" 2>/dev/null && pwd || true)"
      [[ -n "$fixture_dir" && ( "$fixture_dir" == "$task_root" || "$fixture_dir" == "$task_root"/* ) ]] \
        || { echo "private-fixture directory must be inside task directory" >&2; exit 4; }
      [[ -n "$fixture_file" && "$fixture_file" != /* && "$fixture_file" != *..* && "$fixture_file" == *_test.go ]] \
        || { echo "private-fixture file path is invalid: $fixture_file" >&2; exit 4; }
      [[ -f "$fixture_dir/$fixture_file" ]] || { echo "private-fixture file is missing: $fixture_file" >&2; exit 4; }
      if [[ -n "$(jq -r '.verification_fixture_sha256 // empty' "$proof_root/public.json")" ]]; then
        expected_fixture_sha="$(jq -r '.verification_fixture_sha256' "$proof_root/public.json")"
        actual_fixture_sha="$(shasum -a 256 "$fixture_dir/$fixture_file" | awk '{print $1}')"
        [[ "$expected_fixture_sha" == "$actual_fixture_sha" ]] || { echo "private-fixture hash mismatch" >&2; exit 4; }
      fi
      mkdir -p "$workspace/$(dirname "$fixture_file")"
      cp "$fixture_dir/$fixture_file" "$workspace/$fixture_file"
      ;;
    repository-tests)
      test_files_tmp="$run_root/repository-test-files.txt"
      jq -r '.verification_test_files[]? // empty' "$proof_root/public.json" >"$test_files_tmp"
      [[ -s "$test_files_tmp" ]] || { echo "repository-tests requires verification_test_files" >&2; exit 4; }
      while IFS= read -r test_file; do
        [[ -z "$test_file" ]] && continue
        [[ "$test_file" != /* && "$test_file" != *".."* && "$test_file" == *_test.go ]] \
          || { echo "invalid verification test path: $test_file" >&2; exit 4; }
        # Legacy repository-owned verification tests may be recovered from the
        # old checkpoint/model-test locations. New V5 tasks use private-fixture
        # above and never enter this compatibility path.
        if [[ ! -f "$workspace/$test_file" ]]; then
          repository_test=""
          for candidate in \
            "$task_dir/workspace/$test_file" \
            "$task_dir/.test-author-checkpoint/workspace/$test_file" \
            "$task_dir/grader/model-tests/$test_file" \
            "$source_dir/$test_file"; do
            if [[ -f "$candidate" ]]; then
              repository_test="$candidate"
              break
            fi
          done
          [[ -n "$repository_test" ]] || {
            echo "repository verification test is not materialized in task workspace, checkpoint, model-tests, or proof source: $test_file" >&2
            exit 4
          }
          task_workspace_test="$task_dir/workspace/$test_file"
          if [[ "$repository_test" != "$task_workspace_test" ]]; then
            mkdir -p "$task_dir/workspace/$(dirname "$test_file")"
            cp "$repository_test" "$task_workspace_test"
          fi
          mkdir -p "$workspace/$(dirname "$test_file")"
          cp "$task_workspace_test" "$workspace/$test_file"
        fi
        [[ -f "$workspace/$test_file" ]] || {
          echo "repository verification test materialization failed: $test_file" >&2
          exit 4
        }
      done < "$test_files_tmp"
      ;;
    none)
      ;;
    gold-tests|test-model-fix-tests|pending-model-tests)
      echo "V5 independent proof cannot use grader-only verification_test_overlay=$test_overlay; commit verification tests to the submitted repository" >&2
      exit 4
      ;;
    *)
      echo "unsupported verification_test_overlay: $test_overlay" >&2
      exit 4
      ;;
  esac
  proof_workdir="$workspace"
fi
cd "$proof_workdir"
claude_args=(
  --print --verbose --effort low --output-format stream-json
  --setting-sources "" --disable-slash-commands
  --tools Bash
  --permission-mode bypassPermissions --allow-dangerously-skip-permissions --dangerously-skip-permissions
)
[[ -z "$claude_model" ]] || claude_args+=(--model "$claude_model")
set +e
"$claude_bin" "${claude_args[@]}" -p "$(<"$prompt_file")" >"$raw_stream" 2>"$stderr_log"
claude_exit=$?
set -e
[[ "$claude_exit" -eq 0 ]] || { tail -c 6000 "$stderr_log" >&2 || true; exit "$claude_exit"; }
actual_model="$(jq -r 'select(.type == "system" and .subtype == "init") | .model // empty' "$raw_stream" | head -n 1)"
if [[ "$actual_model" != "$claude_model" ]]; then
  echo "Claude 验证模型不匹配：期望 $claude_model，实际 ${actual_model:-未报告}" >&2
  exit 78
fi

session_id="$(jq -r 'select(.type == "result") | .session_id' "$raw_stream" | tail -n 1)"
[[ "$session_id" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "missing verification Session UUID" >&2; exit 6; }
native_source="$(find "$CLAUDE_CONFIG_DIR/projects" -type f -name "${session_id}.jsonl" -print -quit 2>/dev/null || true)"
[[ -s "$native_source" ]] || { echo "missing Claude native transcript for verification session $session_id" >&2; exit 7; }
node "$result_extractor" "$phase" "$proof_root/public.json" "$native_source" "$raw_stream" "$proof_root" >/dev/null
[[ -s "$result_file" && -s "$proof_root/verification-command-results.jsonl" ]] || { echo "verification result extraction failed" >&2; exit 5; }

expected_result="red"
[[ "$phase" == "pre_fix" ]] || expected_result="green"
actual_result="$(jq -r '.result' "$result_file")"
[[ "$actual_result" == "$expected_result" ]] || {
  echo "$phase verification expected $expected_result, got $actual_result" >&2
  jq . "$result_file" >&2
  exit 8
}

trajectory_filename="trajectory_${session_id}.jsonl"
cp "$native_source" "$output_dir/$trajectory_filename"
cp "$raw_stream" "$output_dir/raw.stream.jsonl"
cp "$stderr_log" "$output_dir/claude.stderr.log"
cp "$result_file" "$output_dir/verification-result.json"
cp "$proof_root/verification-command-results.jsonl" "$output_dir/verification-command-results.jsonl"
cp "$prompt_file" "$output_dir/PROMPT.md"

source_commit="$(jq -r --arg phase "$phase" 'if $phase == "pre_fix" then .bug_base_commit else .test_model_fix_commit end // empty' "$task_dir/public.json")"
[[ "$source_commit" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "$phase source commit is missing or invalid" >&2; exit 9; }
verify_cmds_sha256="$(jq -c '.verify_cmds' "$task_dir/public.json" | shasum -a 256 | awk '{print $1}')"
trajectory_sha256="$(shasum -a 256 "$output_dir/$trajectory_filename" | awk '{print $1}')"
raw_stream_sha256="$(shasum -a 256 "$output_dir/raw.stream.jsonl" | awk '{print $1}')"
prompt_sha256="$(shasum -a 256 "$output_dir/PROMPT.md" | awk '{print $1}')"
result_sha256="$(shasum -a 256 "$output_dir/verification-result.json" | awk '{print $1}')"
command_results_sha256="$(shasum -a 256 "$output_dir/verification-command-results.jsonl" | awk '{print $1}')"
command_count="$(jq '.verify_cmds | length' "$task_dir/public.json")"
claude_code_version="$(jq -rs '[.[] | select(.type == "system" and .subtype == "init") | .claude_code_version // empty] | map(select(length > 0)) | first // ""' "$raw_stream")"
jq -n \
  --arg policy_version "5" --arg phase "$phase" --arg session_id "$session_id" \
  --arg source_commit "$source_commit" --arg verify_cmds_sha256 "$verify_cmds_sha256" \
  --arg trajectory_sha256 "$trajectory_sha256" --arg trajectory_filename "$trajectory_filename" \
  --arg raw_stream_sha256 "$raw_stream_sha256" --arg prompt_sha256 "$prompt_sha256" \
  --arg result_sha256 "$result_sha256" --arg command_results_sha256 "$command_results_sha256" \
  --arg result "$actual_result" --arg claude_code_version "$claude_code_version" \
  --arg command_mode "direct_verify_cmds_v2" --argjson command_count "$command_count" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson exit_code "$(jq '.exit_code' "$result_file")" \
  '{policy_version:($policy_version|tonumber),phase:$phase,command_mode:$command_mode,command_count:$command_count,session_id:$session_id,source_commit:$source_commit,verify_cmds_sha256:$verify_cmds_sha256,trajectory_sha256:$trajectory_sha256,trajectory_filename:$trajectory_filename,raw_stream_sha256:$raw_stream_sha256,prompt_sha256:$prompt_sha256,result_sha256:$result_sha256,command_results_sha256:$command_results_sha256,result:$result,exit_code:$exit_code,claude_code_version:$claude_code_version,created_at:$created_at}' \
  >"$output_dir/manifest.json"
chmod 0444 "$output_dir"/*
printf '%s\n' "$output_dir/manifest.json"
