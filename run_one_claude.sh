#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 TASK_DIR" >&2
  exit 2
fi

task_dir="$(cd "$1" && pwd)"
work_root="$(cd "$task_dir/../../.." && pwd)"
project_root="$(cd "$work_root/.." && pwd)"
task_library_root="$(cd "$task_dir/../.." && pwd)"
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
publisher="$runner_root/publish_test_model_fix.sh"
v4_publisher="$runner_root/scripts/publish-v4-git-layout.sh"
timeout_runner="$runner_root/scripts/run-with-timeout.mjs"
project_validator="$runner_root/scripts/validate-go-package.mjs"
docker_grader="$runner_root/scripts/run-docker-task-grader.sh"
grader_collision_checker="$runner_root/scripts/check-grader-collisions.mjs"
canonical_exporter="$runner_root/scripts/export-canonical-trajectory.mjs"
trajectory_validator="$runner_root/scripts/validate-trajectories.mjs"
audit_hook_source="$runner_root/scripts/claude-v4-hook.mjs"
diagnosis_readonly_checker="$runner_root/scripts/check-diagnosis-read-only.mjs"
diagnosis_denial_classifier="$runner_root/scripts/classify-diagnosis-permission-denial.mjs"
node_bin="$(command -v node)"
workspace="$task_dir/workspace"
raw="$task_dir/trajectory/raw.stream.jsonl"
stderr="$task_dir/trajectory/claude.stderr.log"
validation_log="$task_dir/trajectory/system-validation.log"
project_validation_log="$task_dir/trajectory/git-project-validation.json"
run_lock="$task_dir/.claude-run.lock"
progress_state="$task_dir/.claude-progress.json"
activity_state="$task_dir/.claude-activity.json"
phase_request_state="$task_dir/.runner-phase-request.json"
phase_admission_state="$task_dir/.runner-phase-admission.json"
phase_observation_state="$task_dir/.runner-phase-observation.json"
progress_stop=""
progress_watcher_pid=""
permission_denied_count=0
permission_denied_limit="${GO_PIPELINE_CLAUDE_PERMISSION_DENIAL_LIMIT:-8}"
if [[ ! "$permission_denied_limit" =~ ^[1-9][0-9]*$ ]]; then
  permission_denied_limit=8
fi
diagnosis_mutation_denied_count=0
diagnosis_mutation_denied_limit=0
permission_denial_stop_reason=""
task_type=""
workflow_version=""
workflow_policy_version=""
verification_policy_version=""
new_private_fixture_flow=0
post_claude_codex_flow=0
mkdir -p "$task_dir/trajectory"
rm -f "$task_dir/.trajectory-policy-v2" "$task_dir/.trajectory-policy-v3" "$task_dir/.trajectory-policy-original-v1"
printf '%s\n' \
  'original-session-events=preserved' \
  'complete-conversation=required' \
  'balanced-tool-events=required' \
  'immutable-runner-manifest=required' \
  'content-quality-review=paused' \
  > "$task_dir/.trajectory-policy-v4"
if ! mkdir "$run_lock" 2>/dev/null; then
  existing_pid="$(cat "$run_lock/pid" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    existing_command="$(ps -p "$existing_pid" -o command= 2>/dev/null || true)"
    # A PID can be reused after a runner dies. Do not let an unrelated process
    # make a task look permanently busy.
    if [[ "$existing_command" != *"$task_dir"* ]]; then
      rm -rf "$run_lock"
    fi
  fi
  if [[ -d "$run_lock" ]]; then
    existing_pid="$(cat "$run_lock/pid" 2>/dev/null || true)"
  fi
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    # A manual Bug switch terminates the old process tree asynchronously. The
    # scheduler can dispatch the replacement before the old runner's EXIT trap
    # removes this lock, so give that cleanup a short grace period.
    lock_wait_seconds="${GO_PIPELINE_CLAUDE_LOCK_WAIT_SECONDS:-60}"
    lock_wait_ticks=$((lock_wait_seconds * 2))
    for ((lock_wait_tick = 0; lock_wait_tick < lock_wait_ticks; lock_wait_tick += 1)); do
      kill -0 "$existing_pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "Claude task runner already active for $task_dir (pid=$existing_pid)" >&2
      exit 75
    fi
  fi
  rm -rf "$run_lock"
  if ! mkdir "$run_lock" 2>/dev/null; then
    existing_pid="$(cat "$run_lock/pid" 2>/dev/null || true)"
    echo "Claude task runner already active for $task_dir (pid=${existing_pid:-unknown})" >&2
    exit 75
  fi
fi
printf '%s\n' "$$" > "$run_lock/pid"
rm -f "$progress_state" "$activity_state" "$phase_request_state" "$phase_admission_state" "$phase_observation_state"
# Task packages retain their own grader copy for reproducibility, but retries
# must receive the current system-side acceptance fixes. Never reuse an older
# copied grader merely because the file already exists.
install -m 0755 "$docker_grader" "$task_dir/grader/run_docker.sh"
if [[ -e "$raw" || -e "$task_dir/trajectory/trajectory.stream.jsonl" ]]; then
  retry_history="$task_library_root/retry-history/$(basename "$task_dir")/runner-retry-$(date +%Y%m%d%H%M%S)-$$"
  mkdir -p "$retry_history"
  find "$task_dir/trajectory" -mindepth 1 -maxdepth 1 -exec mv {} "$retry_history/" \;
  echo "archived stale trajectory state to $retry_history" >&2
fi

run_root="$(mktemp -d "${TMPDIR:-/tmp}/go-task-claude.XXXXXX")"
prompt_file="$run_root/user-prompt.txt"
if ! jq -er '.user_query | strings | select(length > 0)' "$task_dir/public.json" >"$prompt_file"; then
  echo "task public.json is missing a non-empty user_query" >&2
  exit 2
fi
sandbox_workspace="$run_root/workspace"
sandbox_pristine="$run_root/pristine"
complete_workspace="$run_root/complete-workspace"
complete_pristine="$run_root/complete-pristine"
sandbox_raw="$run_root/raw.stream.jsonl"
sandbox_stderr="$run_root/claude.stderr.log"
native_candidate="$run_root/native.session.jsonl"
audit_log="$run_root/mutation-audit.jsonl"
hook_settings="$run_root/claude-hook-settings.json"
hook_runtime="$run_root/hook-runtime"
canonical_candidate="$run_root/trajectory.canonical.jsonl"
manifest_candidate="$run_root/runner-manifest.json"
repair_checkpoint="$task_dir/.repair-checkpoint"
test_author_checkpoint="$task_dir/.test-author-checkpoint"
red_green_checkpoint="$task_dir/.red-green-checkpoint"
publish_checkpoint="$task_dir/.publish-checkpoint"
post_fix_checkpoint="$task_dir/.post-fix-checkpoint"
export CLAUDE_CONFIG_DIR="$run_root/claude-config"
mkdir -p "$sandbox_workspace" "$sandbox_pristine" "$complete_workspace" "$complete_pristine"
mkdir -p "$CLAUDE_CONFIG_DIR"
cp -R "$workspace/." "$sandbox_workspace/"
cp -R "$task_dir/pristine/." "$sandbox_pristine/"
cp -R "$workspace/." "$complete_workspace/"
cp -R "$task_dir/pristine/." "$complete_pristine/"

remove_writable_tree() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  chmod -R u+w "$target" 2>/dev/null || true
  rm -rf "$target"
}

remove_generated_compiler_artifacts() {
  local target="$1"
  local baseline="$2"
  local log_file="${3:-}"
  [[ -d "$target" ]] || return 0
  command -v file >/dev/null 2>&1 || return 0
  while IFS= read -r -d '' candidate; do
    local relative description
    relative="${candidate#"$target"/}"
    [[ "$relative" != "$candidate" && ! -e "$baseline/$relative" ]] || continue
    description="$(file -b "$candidate" 2>/dev/null || true)"
    if [[ "$description" == Mach-O* || "$description" == ELF*executable* || "$description" == PE32* ]]; then
      if [[ -n "$log_file" ]]; then
        printf 'removed generated compiler artifact: %s\n' "$relative" >>"$log_file"
      fi
      rm -f "$candidate"
    fi
  done < <(find "$target" -type f -print0)
}

# The repair Session receives the complete ordinary project workspace. Only
# answer-bearing material is removed before Claude starts; pre-existing tests,
# project documentation, scripts, and Dockerfiles remain available as normal
# engineering context.
prune_forbidden_material() {
  local root="$1"
  # Only remove pipeline-owned paths at the project root. Broad recursive name
  # matching can delete legitimate domain files such as answer.go or patch.go.
  for relative in .git grader gold hidden-tests hidden_tests trajectory; do
    remove_writable_tree "$root/$relative"
  done
  find "$root" -maxdepth 1 -type f \( \
    -iname 'BUG_REPRO*' -o -name 'verify_cmds' -o -name 'verify_cmds.sh' \
  \) -delete
  local declared_task_type verification_overlay
  declared_task_type="$(jq -r '.task_type // empty' "$task_dir/public.json" 2>/dev/null || true)"
  verification_overlay="$(jq -r '.verification_test_overlay // "none"' "$task_dir/public.json" 2>/dev/null || printf 'none')"
  # A diagnosis may intentionally point at an ordinary test that was already
  # part of the submitted repository. It is public source context, not a
  # system-authored answer fixture, and removing it would make the immutable
  # workspace guard report a false model mutation.
  if [[ "$declared_task_type" == "diagnosis" && "$verification_overlay" == "repository-tests" ]]; then
    return 0
  fi
  # Codex freezes the acceptance test before this Session, but the repair
  # workspace must not contain it. Remove only the exact declared paths so
  # legitimate domain files such as answer.go or patcher.go survive.
  while IFS= read -r verification_file; do
    [[ -n "$verification_file" && "$verification_file" != /* && "$verification_file" != *".."* ]] || continue
    rm -f "$root/$verification_file"
  done < <(jq -r '.verification_test_files[]? // empty' "$task_dir/public.json" 2>/dev/null || true)
}
prune_forbidden_material "$sandbox_workspace"
prune_forbidden_material "$sandbox_pristine"
workspace_committed=0

# A private TestModel_ fixture is frozen for the later proof Sessions, never
# for the repair Session. Remove an exact declared fixture path from every
# repair copy so a stale retry workspace cannot reintroduce the test.
prune_private_fixture_material() {
  local root="$1"
  [[ "${new_private_fixture_flow:-0}" -eq 1 ]] || return 0
  local overlay
  overlay="$(jq -r '.verification_test_overlay // "none"' "$task_dir/public.json" 2>/dev/null || printf 'none')"
  [[ "$overlay" == "private-fixture" ]] || return 0
  while IFS= read -r fixture_file; do
    [[ -n "$fixture_file" ]] || continue
    [[ "$fixture_file" != /* && "$fixture_file" != *".."* ]] || continue
    rm -f "$root/$fixture_file"
  done < <(jq -r '.verification_test_files[]? // empty' "$task_dir/public.json" 2>/dev/null || true)
}

tree_content_fingerprint() {
  local root="$1"
  (
    cd "$root"
    find . -type f ! -path './.git/*' -print \
      | LC_ALL=C sort \
      | while IFS= read -r file; do
          printf '%s\0' "$file"
          shasum -a 256 "$file"
        done \
      | shasum -a 256 \
      | awk '{print $1}'
  )
}

# A bugfix checkpoint must contain an implementation/configuration change. Tests
# are authored independently after Claude exits, so a test-only or unchanged tree
# is never a reusable repair even when the CLI itself returned success.
bugfix_workspace_has_non_test_change() {
  local baseline="$1"
  local candidate="$2"
  if diff -qr --exclude='.git' --exclude='*_test.go' "$baseline" "$candidate" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# Bind every stage checkpoint to the same answer-free BUG_BASE snapshot. Later
# stages restore ordinary tests into sandbox_pristine for red/green execution,
# so computing this lazily would make otherwise valid checkpoints look stale.
checkpoint_pristine_sha256="$(tree_content_fingerprint "$sandbox_pristine")"

current_prompt_sha256() {
  shasum -a 256 "$prompt_file" | awk '{print $1}'
}

current_pristine_sha256() {
  printf '%s\n' "$checkpoint_pristine_sha256"
}

# Keep the exact workspace that was accepted and published. Post-fix proof
# only needs this clean source tree; re-cloning the just-published commit adds
# a second network dependency and can turn a Git transient into a long proof
# failure. The pipeline checks the published commit before reusing it.
save_post_fix_checkpoint() {
  local published_commit="$1"
  local checkpoint_session="${2:-${session_id:-}}"
  local temporary="$post_fix_checkpoint.$$"
  remove_writable_tree "$temporary"
  mkdir -p "$temporary"
  jq -n \
    --arg commit "$published_commit" \
    --arg workspace "$workspace" \
    --arg session_id "$checkpoint_session" \
    '{version: 1, stage: "git_publication_complete", source_commit: $commit, workspace: $workspace, session_id: $session_id, saved_at: (now | todate)}' \
    >"$temporary/checkpoint.json"
  remove_writable_tree "$post_fix_checkpoint"
  mv "$temporary" "$post_fix_checkpoint"
  find "$post_fix_checkpoint" -type f -exec chmod a-w {} +
}

# The Claude CLI emits progress events while it is thinking, even when the
# isolated workspace has not changed for a long time. Keep the file fingerprint
# for implementation progress and a separate marker for effective tool events;
# the outer runner can then ignore heartbeat-only output without killing a real
# command that is still running.
workspace_fingerprint() {
  find "$sandbox_workspace" -type f ! -path '*/.git/*' -print0 2>/dev/null \
    | while IFS= read -r -d '' file; do
        # Claude may move or remove a file between find and stat. Treat that
        # race as a normal transient snapshot miss instead of leaking a shell
        # error into the runner output.
        [[ -f "$file" ]] || continue
        metadata="$(stat -c '%s:%Y' -- "$file" 2>/dev/null || stat -f '%z:%m' "$file" 2>/dev/null || true)"
        [[ -n "$metadata" ]] || continue
        printf '%s:%s\n' "$file" "$metadata"
      done \
    | LC_ALL=C sort \
    | shasum -a 256 \
    | awk '{print $1}'
}

write_progress_state() {
  local signature="$1"
  local reason="${2:-workspace_changed}"
  local temporary="$progress_state.${BASHPID:-$$}.${RANDOM}"
  jq -n \
    --arg signature "$signature" \
    --arg reason "$reason" \
    --arg workspace "$workspace" \
    --arg session_id "${session_id:-}" \
    '{version: 1, reason: $reason, workspace: $workspace, session_id: $session_id, workspace_signature: $signature, changed_at: (now | todate)}' \
    >"$temporary"
  mv -f "$temporary" "$progress_state"
}

mark_runner_phase() {
  local phase="$1"
  local signature
  signature="$(workspace_fingerprint)"
  write_progress_state "${signature:-unavailable}" "runner_phase:$phase"
  local temporary="$phase_observation_state.$$"
  jq -n --arg phase "$phase" --arg session_id "${session_id:-}" \
    '{version:1,phase:$phase,session_id:$session_id,observed_at:(now|todate)}' >"$temporary"
  mv -f "$temporary" "$phase_observation_state"
}

request_phase_resource() {
  local phase="$1"
  mark_runner_phase "$phase"
  [[ "${GO_PIPELINE_PHASE_RESOURCE_HANDSHAKE:-0}" == "1" ]] || return 0
  local request_id="${session_id:-pending}:$phase:$(date +%s):$$"
  local temporary="$phase_request_state.$$"
  jq -n \
    --arg request_id "$request_id" \
    --arg phase "$phase" \
    --arg session_id "${session_id:-}" \
    '{version:1,request_id:$request_id,phase:$phase,session_id:$session_id,requested_at:(now|todate)}' \
    >"$temporary"
  mv -f "$temporary" "$phase_request_state"
  local tick
  for ((tick = 0; tick < 1200; tick += 1)); do
    if [[ -s "$phase_admission_state" \
      && "$(jq -r '.request_id // empty' "$phase_admission_state" 2>/dev/null || true)" == "$request_id" ]]; then
      return 0
    fi
    sleep 0.1
  done
  echo "phase resource admission timed out: $phase" >&2
  exit 76
}

# Preserve selected stream events for postmortem diagnosis. The outer runner
# deliberately does not count this file as progress: Read/Bash/tool_result and
# api_retry events are observations, not source or test output.
write_activity_state() {
  local event_type="$1"
  local event_subtype="$2"
  local denied_count="${3:-0}"
  local mutation_denied_count="${4:-0}"
  local temporary="$activity_state.$$"
  jq -n \
    --arg event_type "$event_type" \
    --arg event_subtype "$event_subtype" \
    --arg workspace "$workspace" \
    --argjson permission_denied_count "$denied_count" \
    --argjson diagnosis_mutation_denied_count "$mutation_denied_count" \
    '{version: 1, reason: "claude_stream_observation", counts_as_progress: false, event_type: $event_type, event_subtype: $event_subtype, permission_denied_count: $permission_denied_count, diagnosis_mutation_denied_count: $diagnosis_mutation_denied_count, workspace: $workspace, changed_at: (now | todate)}' \
    >"$temporary"
  mv -f "$temporary" "$activity_state"
}

record_stream_activity() {
  local line="$1"
  local activity
  activity="$(jq -r '
    (.type // "") as $type |
    (.subtype // "") as $subtype |
    (.message? | if type == "object" then (.content? // null) else null end) as $content |
    ([if ($content | type) == "array" then $content[]?.type else empty end] | map(select(. == "tool_use" or . == "tool_result" or . == "tool")) | length) as $tools |
    ([if ($content | type) == "array" then $content[]? else empty end]
      | map(select(.type == "tool_result" and .is_error == true and ((.content // "") | tostring | test("diagnosis 任务禁止"))))
      | length > 0) as $hook_mutation_denied |
    ([if ($content | type) == "array" then $content[]? else empty end]
      | map(select(.type == "tool_result" and .is_error != true))
      | length > 0) as $successful_tool_result |
    if $tools > 0 or (($type == "system") and ($subtype == "init" or $subtype == "api_retry" or $subtype == "permission_denied")) or ($type == "result")
    then [$type, $subtype, (if $hook_mutation_denied then "mutation" else "none" end), (if $successful_tool_result then "success" else "none" end)] | join("\u001e") else "" end
  ' <<<"$line" 2>/dev/null || true)"
  [[ -n "$activity" ]] || return 0
  local event_type="${activity%%$'\x1e'*}"
  local activity_tail="${activity#*$'\x1e'}"
  local event_subtype="${activity_tail%%$'\x1e'*}"
  local activity_flags="${activity_tail#*$'\x1e'}"
  local denial_kind="${activity_flags%%$'\x1e'*}"
  local tool_result_kind="${activity_flags#*$'\x1e'}"
  if [[ "$event_type" == "system" && "$event_subtype" == "permission_denied" ]]; then
    permission_denied_count=$((permission_denied_count + 1))
    if [[ "$task_type" == "diagnosis" ]]; then
      local denial_classification
      denial_classification="$("$node_bin" "$diagnosis_denial_classifier" <<<"$line" 2>/dev/null || printf 'mutation')"
      if [[ "$denial_classification" != "read_only" ]]; then
        diagnosis_mutation_denied_count=$((diagnosis_mutation_denied_count + 1))
      fi
    fi
  elif [[ "$task_type" == "diagnosis" && "$denial_kind" == "mutation" ]]; then
    permission_denied_count=$((permission_denied_count + 1))
    diagnosis_mutation_denied_count=$((diagnosis_mutation_denied_count + 1))
  elif [[ "$tool_result_kind" == "success" ]]; then
    # Count only an uninterrupted denial loop. Once Claude follows the policy
    # and completes an allowed command, earlier denials must not kill a valid
    # repair later in the same Session.
    permission_denied_count=0
  fi
  write_activity_state "$event_type" "$event_subtype" "$permission_denied_count" "$diagnosis_mutation_denied_count"
  if (( permission_denied_count >= permission_denied_limit )); then
    permission_denial_stop_reason="${permission_denied_count} repeated permission denials"
    return 1
  fi
  if (( diagnosis_mutation_denied_limit > 0 && diagnosis_mutation_denied_count >= diagnosis_mutation_denied_limit )); then
    permission_denial_stop_reason="${diagnosis_mutation_denied_count} diagnosis mutation denial"
    return 1
  fi
  return 0
}

terminate_claude_pipeline_siblings() {
  local pipeline_parent_pid="$1"
  local child_pid
  local current_pid="${BASHPID:-}"
  if [[ -z "$current_pid" ]]; then
    current_pid="$(/bin/sh -c 'printf %s "$PPID"')"
  fi
  while IFS= read -r child_pid; do
    [[ "$child_pid" =~ ^[0-9]+$ ]] || continue
    [[ "$child_pid" == "$current_pid" ]] && continue
    kill "$child_pid" 2>/dev/null || true
  done < <(/usr/bin/pgrep -P "$pipeline_parent_pid" 2>/dev/null || true)
}

start_progress_watcher() {
  progress_stop="$run_root/.progress-stop"
  rm -f "$progress_stop"
  initial_signature="$(workspace_fingerprint)"
  write_progress_state "$initial_signature"
  (
    last_signature="$initial_signature"
    first_workspace_change=1
    while [[ ! -e "$progress_stop" ]]; do
      sleep 5
      [[ -e "$progress_stop" ]] && break
      next_signature="$(workspace_fingerprint)"
      if [[ -n "$next_signature" && "$next_signature" != "$last_signature" ]]; then
        last_signature="$next_signature"
        if [[ "$first_workspace_change" -eq 1 ]]; then
          first_workspace_change=0
          write_progress_state "$next_signature" "runner_phase:first_source_edit"
          local_observation="$phase_observation_state.watcher.$$"
          jq -n --arg phase "first_source_edit" --arg session_id "${session_id:-}" \
            '{version:1,phase:$phase,session_id:$session_id,observed_at:(now|todate)}' >"$local_observation"
          mv -f "$local_observation" "$phase_observation_state"
        else
          write_progress_state "$next_signature"
        fi
      fi
    done
  ) &
  progress_watcher_pid=$!
}

archive_incomplete_stream() {
  exit_code=$?
  if [[ -n "$progress_stop" ]]; then
    : >"$progress_stop" 2>/dev/null || true
  fi
  if [[ -n "$progress_watcher_pid" ]]; then
    kill "$progress_watcher_pid" 2>/dev/null || true
    wait "$progress_watcher_pid" 2>/dev/null || true
  fi
  if [[ -e "$sandbox_stderr" ]]; then
    cp "$sandbox_stderr" "$stderr"
  fi
  if [[ "$exit_code" -ne 0 && -e "$sandbox_raw" ]]; then
    mv "$sandbox_raw" "$task_dir/trajectory/raw.stream.$(date +%Y%m%d%H%M%S).$$.incomplete.jsonl"
  fi
  if [[ "$exit_code" -ne 0 && -e "$raw" ]]; then
    mv "$raw" "$task_dir/trajectory/raw.stream.$(date +%Y%m%d%H%M%S).$$.incomplete.jsonl"
  fi
  if [[ "$exit_code" -ne 0 && "$workspace_committed" -ne 1 ]]; then
    rm -rf "$workspace"
    mkdir -p "$workspace"
    cp -R "$sandbox_pristine/." "$workspace/"
  fi
  chmod -R u+w "$run_root" 2>/dev/null || true
  rm -rf "$run_root" || true
  rm -rf "$run_lock" || true
}
trap archive_incomplete_stream EXIT

export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export GOSUMDB="${GOSUMDB:-off}"
export GOTOOLCHAIN=local
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
toolchain_version="${GO_PIPELINE_GO_TOOLCHAIN_VERSION:-1.25.6}"
export PATH="$work_root/toolchains/go${toolchain_version}/bin:${PATH}"
export GOCACHE="$run_root/gocache"
export GOMODCACHE="$run_root/gomodcache"
export GOTMPDIR="$run_root/gotmp"
export GIT_CEILING_DIRECTORIES="$sandbox_workspace"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GH_CONFIG_DIR="$run_root/empty-gh-config"
mkdir -p "$GH_CONFIG_DIR"
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOTMPDIR"
export TMPDIR="$GOTMPDIR"

task_type="$(jq -r '.task_type // empty' "$task_dir/public.json")"
workflow_version="$(jq -r '.workflow_version // 1' "$task_dir/public.json")"
workflow_policy_version="$(jq -r '.workflow_policy_version // 0' "$task_dir/public.json")"
verification_policy_version="$(jq -r '.verification_policy_version // 0' "$task_dir/public.json")"
if [[ "$task_type" != "bugfix" && "$task_type" != "diagnosis" ]]; then
  echo "unsupported task type: $task_type" >&2
  exit 2
fi
if [[ "$task_type" == "diagnosis" ]]; then
  # One denied mutation attempt is enough to make the native conversation
  # unsuitable for delivery. End it immediately so the pipeline retries with
  # a fresh, clean Session instead of recording that write intent in main.
  # Read-only denials (for example a blocked Git inspection) still count
  # toward the general loop guard but do not consume the mutation limit.
  diagnosis_mutation_denied_limit=1
fi
export V4_TASK_TYPE="$task_type"
export V4_WORKSPACE_ROOT="$sandbox_workspace"
export V4_TEMP_ROOT="$run_root"
export V4_AUDIT_LOG="$audit_log"
if [[ "$workflow_policy_version" =~ ^[0-9]+$ && "$verification_policy_version" =~ ^[0-9]+$ \
  && "$workflow_policy_version" -ge 4 && "$verification_policy_version" -ge 5 ]]; then
  new_private_fixture_flow=1
fi
# New V3 Bugfixes stop after the Claude repair checkpoint.  The independent
# Codex Session writes the acceptance test in the parent pipeline; Docker and
# Git publication therefore must not run in this Claude process.
verification_test_overlay_now="$(jq -r '.verification_test_overlay // "none"' "$task_dir/public.json" 2>/dev/null || printf 'none')"
if [[ "$workflow_version" =~ ^[0-9]+$ && "$workflow_version" -ge 3 && "$task_type" == "bugfix" \
  && "$verification_test_overlay_now" != "repository-tests" ]]; then
  post_claude_codex_flow=1
fi
# Policy-4/V5 tasks use the orphan G1/G2/R1 Git layout. Keep the legacy
# publisher available for historical tasks, but make the new layout the actual
# delivery path for every new repair Session.
if [[ "$new_private_fixture_flow" -eq 1 ]]; then
  publisher="$v4_publisher"
fi
# New policy-4/V5 tasks have no independent test-author or local red/green
# checkpoint stage. Discard remnants from an older attempt before recovery so a
# restart cannot silently re-enter that retired flow.
if [[ "$new_private_fixture_flow" -eq 1 ]]; then
  remove_writable_tree "$test_author_checkpoint"
  remove_writable_tree "$red_green_checkpoint"
fi
prune_private_fixture_material "$sandbox_workspace"
prune_private_fixture_material "$sandbox_pristine"
prune_private_fixture_material "$complete_workspace"
prune_private_fixture_material "$complete_pristine"
# The repair Session never authors or receives the private TestModel_ fixture.
# The fixture is frozen before this script starts and is overlaid only by the
# later proof and publication stages.
defer_model_tests=0

checkpoint_context_matches() {
  local metadata="$1"
  [[ -s "$metadata" ]] || return 1
  local saved_task_type saved_workflow saved_policy saved_verification_policy saved_prompt saved_pristine
  saved_task_type="$(jq -r '.task_type // empty' "$metadata")"
  saved_workflow="$(jq -r '.workflow_version // empty' "$metadata")"
  saved_policy="$(jq -r '.workflow_policy_version // 0' "$metadata")"
  saved_verification_policy="$(jq -r '.verification_policy_version // 0' "$metadata")"
  saved_prompt="$(jq -r '.prompt_sha256 // empty' "$metadata")"
  saved_pristine="$(jq -r '.pristine_sha256 // empty' "$metadata")"
  [[ "$saved_task_type" == "$task_type" \
    && "$saved_workflow" == "$workflow_version" \
    && "$saved_policy" == "$workflow_policy_version" \
    && "$saved_verification_policy" == "$verification_policy_version" \
    && "$saved_prompt" == "$(current_prompt_sha256)" \
    && "$saved_pristine" == "$(current_pristine_sha256)" ]]
}

write_checkpoint_metadata() {
  local output="$1"
  local stage="$2"
  local repair_session="$3"
  local author_session="${4:-}"
  jq -n \
    --arg stage "$stage" \
    --arg session_id "$repair_session" \
    --arg test_author_session_id "$author_session" \
    --arg task_type "$task_type" \
    --arg workflow_version "$workflow_version" \
    --arg workflow_policy_version "$workflow_policy_version" \
    --arg verification_policy_version "$verification_policy_version" \
    --arg claude_code_version "${claude_code_version:-}" \
    --arg prompt_sha256 "$(current_prompt_sha256)" \
    --arg pristine_sha256 "$(current_pristine_sha256)" \
    '{
      version: 1,
      stage: $stage,
      session_id: $session_id,
      test_author_session_id: $test_author_session_id,
      task_type: $task_type,
      workflow_version: ($workflow_version | tonumber),
      workflow_policy_version: ($workflow_policy_version | tonumber),
      verification_policy_version: ($verification_policy_version | tonumber),
      claude_code_version: $claude_code_version,
      prompt_sha256: $prompt_sha256,
      pristine_sha256: $pristine_sha256,
      saved_at: (now | todate)
    }' >"$output"
}

save_repair_checkpoint() {
  local temporary="$repair_checkpoint.$$"
  remove_writable_tree "$temporary"
  remove_generated_compiler_artifacts "$sandbox_workspace" "$sandbox_pristine" "$validation_log"
  mkdir -p "$temporary/workspace"
  rsync -a --checksum --delete "$sandbox_workspace/" "$temporary/workspace/"
  cp "$raw" "$temporary/trajectory.stream.jsonl"
  cp "$native_candidate" "$temporary/raw.native.jsonl"
  cp "$canonical_candidate" "$temporary/trajectory.jsonl"
  cp "$audit_log" "$temporary/mutation-audit.jsonl"
  cp "$manifest_candidate" "$temporary/runner-manifest.json"
  write_checkpoint_metadata "$temporary/checkpoint.json" "claude_repair_complete" "$session_id"
  remove_writable_tree "$repair_checkpoint"
  mv "$temporary" "$repair_checkpoint"
  find "$repair_checkpoint" -type f -exec chmod a-w {} +
  # Red/green and Docker results bind to this exact repair. A focused public
  # test is specification evidence and can be replayed against a later repair.
  remove_writable_tree "$red_green_checkpoint"
}

restore_repair_checkpoint() {
  local metadata="$repair_checkpoint/checkpoint.json"
  [[ -d "$repair_checkpoint/workspace" ]] || return 1
  checkpoint_context_matches "$metadata" || return 1
  for required in trajectory.stream.jsonl raw.native.jsonl trajectory.jsonl runner-manifest.json; do
    [[ -s "$repair_checkpoint/$required" ]] || return 1
  done
  [[ -f "$repair_checkpoint/mutation-audit.jsonl" ]] || return 1
  session_id="$(jq -r '.session_id // empty' "$metadata")"
  claude_code_version="$(jq -r '.claude_code_version // empty' "$metadata")"
  [[ -n "$session_id" && -n "$claude_code_version" ]] || return 1
  if [[ "$task_type" == "bugfix" ]] \
    && ! bugfix_workspace_has_non_test_change "$sandbox_pristine" "$repair_checkpoint/workspace"; then
    echo "discarding unchanged bugfix repair checkpoint for session $session_id" >&2
    return 1
  fi
  if [[ "$task_type" == "diagnosis" ]]; then
    if ! diff -qr --exclude='.git' "$sandbox_pristine" "$repair_checkpoint/workspace" >/dev/null 2>&1; then
      echo "discarding diagnosis repair checkpoint that modified the isolated workspace" >&2
      return 1
    fi
    if ! "$node_bin" "$diagnosis_readonly_checker" \
      "$repair_checkpoint/raw.native.jsonl" \
      "$repair_checkpoint/mutation-audit.jsonl" \
      "$repair_checkpoint/workspace"; then
      echo "discarding diagnosis repair checkpoint with a write attempt in its trajectory" >&2
      return 1
    fi
  fi
  rsync -a --checksum --delete "$repair_checkpoint/workspace/" "$sandbox_workspace/"
  cp "$repair_checkpoint/trajectory.stream.jsonl" "$raw"
  cp "$repair_checkpoint/raw.native.jsonl" "$native_candidate"
  cp "$repair_checkpoint/trajectory.jsonl" "$canonical_candidate"
  cp "$repair_checkpoint/mutation-audit.jsonl" "$audit_log"
  cp "$repair_checkpoint/runner-manifest.json" "$manifest_candidate"
}

save_test_author_checkpoint() {
  local author_session="$1"
  local temporary="$test_author_checkpoint.$$"
  remove_writable_tree "$temporary"
  mkdir -p "$temporary/workspace"
  rsync -a --checksum --delete "$complete_workspace/" "$temporary/workspace/"
  cp "$task_dir/public.json" "$temporary/public.json"
  cp "$task_dir/trajectory/test-author-result.json" "$temporary/test-author-result.json"
  if [[ -d "$task_dir/trajectory/test-author-$author_session" ]]; then
    cp -R "$task_dir/trajectory/test-author-$author_session" "$temporary/test-author-trajectory"
  fi
  while IFS= read -r test_file; do
    [[ -z "$test_file" ]] && continue
    [[ -f "$temporary/workspace/$test_file" ]] \
      || { echo "test-author checkpoint is missing repository test: $test_file" >&2; return 1; }
  done < <(jq -r '.test_files[]?' "$temporary/test-author-result.json")
  write_checkpoint_metadata "$temporary/checkpoint.json" "independent_test_complete" "$session_id" "$author_session"
  remove_writable_tree "$test_author_checkpoint"
  mv "$temporary" "$test_author_checkpoint"
  find "$test_author_checkpoint" -type f -exec chmod a-w {} +
  remove_writable_tree "$red_green_checkpoint"
}

# Persist repository-owned model tests before handing the task to the next
# resource stage.  The author runs against complete_workspace (a temporary
# full copy); waiting until the later Docker/publish boundary leaves a window
# where an independent proof runner can observe a workspace without the tests.
sync_test_author_files_to_task_workspace() {
  local result_file="$task_dir/trajectory/test-author-result.json"
  [[ -s "$result_file" ]] || { echo "test-author result is missing" >&2; return 1; }
  while IFS= read -r test_file; do
    [[ -n "$test_file" ]] || continue
    [[ "$test_file" != /* && "$test_file" != *".."* && "$test_file" == *_test.go ]] \
      || { echo "invalid test-author file path: $test_file" >&2; return 1; }
    [[ -f "$complete_workspace/$test_file" ]] \
      || { echo "test-author file missing from complete workspace: $test_file" >&2; return 1; }
    mkdir -p "$workspace/$(dirname "$test_file")"
    cp "$complete_workspace/$test_file" "$workspace/$test_file"
    [[ -f "$workspace/$test_file" ]] \
      || { echo "test-author file was not persisted to task workspace: $test_file" >&2; return 1; }
  done < <(jq -r '.test_files[]?' "$result_file")
}

# Repository acceptance tests are authored outside the repair workspace. Restore
# the exact declared files at every Docker/publication boundary so a retry cannot
# publish a validated repair without the test that proved it.
sync_repository_verification_tests() {
  local target_workspace="$1"
  local verification_overlay
  verification_overlay="$(jq -r '.verification_test_overlay // "none"' "$task_dir/public.json")"
  [[ "$task_type" == "bugfix" && "$verification_overlay" == "repository-tests" ]] || return 0

  local task_root source_dir source_root test_file expected_sha actual_sha candidate candidate_sha candidate_root
  task_root="$(cd "$task_dir" && pwd)"
  source_dir="$(jq -r '.verification_test_source_dir // empty' "$task_dir/public.json")"
  source_root=""
  if [[ -n "$source_dir" && -d "$source_dir" ]]; then
    source_root="$(cd "$source_dir" && pwd)"
    if [[ "$source_root" != "$task_root" && "$source_root" != "$task_root"/* ]]; then
      echo "verification test source escapes the task directory: $source_root" >&2
      return 1
    fi
  fi

  while IFS= read -r test_file; do
    [[ -n "$test_file" ]] || continue
    [[ "$test_file" != /* && "$test_file" != *".."* && "$test_file" == *_test.go ]] \
      || { echo "invalid repository verification test path: $test_file" >&2; return 1; }
    expected_sha="$(jq -r --arg path "$test_file" '
      ([.verification_test_manifest[]? | select(.path == $path) | .sha256][0] //
        (if ((.verification_test_files // []) | length) == 1
         then (.verification_test_sha256 // "") else "" end))
    ' "$task_dir/public.json")"
    [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] \
      || { echo "repository verification test has no valid SHA-256: $test_file" >&2; return 1; }

    actual_sha=""
    if [[ -f "$target_workspace/$test_file" ]]; then
      actual_sha="$(shasum -a 256 "$target_workspace/$test_file" | awk '{print $1}')"
    fi
    [[ "$actual_sha" == "$expected_sha" ]] && continue

    candidate=""
    for candidate_root in "$source_root" "$red_green_checkpoint/workspace" "$test_author_checkpoint/workspace" "$workspace"; do
      [[ -n "$candidate_root" && -f "$candidate_root/$test_file" ]] || continue
      candidate_sha="$(shasum -a 256 "$candidate_root/$test_file" | awk '{print $1}')"
      if [[ "$candidate_sha" == "$expected_sha" ]]; then
        candidate="$candidate_root/$test_file"
        break
      fi
    done
    [[ -n "$candidate" ]] \
      || { echo "trusted repository verification test is missing or has the wrong hash: $test_file" >&2; return 1; }
    mkdir -p "$target_workspace/$(dirname "$test_file")"
    rm -f "$target_workspace/$test_file"
    cp "$candidate" "$target_workspace/$test_file"
    actual_sha="$(shasum -a 256 "$target_workspace/$test_file" | awk '{print $1}')"
    [[ "$actual_sha" == "$expected_sha" ]] \
      || { echo "restored repository verification test failed SHA-256 validation: $test_file" >&2; return 1; }
  done < <(jq -r '.verification_test_files[]? // empty' "$task_dir/public.json")
}

restore_test_author_checkpoint() {
  local metadata="$test_author_checkpoint/checkpoint.json"
  [[ -d "$test_author_checkpoint/workspace" \
    && -s "$test_author_checkpoint/public.json" \
    && -s "$test_author_checkpoint/test-author-result.json" ]] || return 1
  checkpoint_context_matches "$metadata" || return 1
  test_author_session_id="$(jq -r '.test_author_session_id // empty' "$metadata")"
  [[ -n "$test_author_session_id" ]] || return 1
  rsync -a --checksum --delete --exclude='*_test.go' "$sandbox_workspace/" "$complete_workspace/"
  while IFS= read -r test_file; do
    [[ -n "$test_file" && -f "$test_author_checkpoint/workspace/$test_file" ]] || return 1
    mkdir -p "$complete_workspace/$(dirname "$test_file")"
    cp "$test_author_checkpoint/workspace/$test_file" "$complete_workspace/$test_file"
  done < <(jq -r '.test_files[]?' "$test_author_checkpoint/test-author-result.json")
  rsync -a --checksum --delete "$complete_pristine/" "$sandbox_pristine/"
  rsync -a --checksum --delete "$complete_workspace/" "$sandbox_workspace/"
  cp "$test_author_checkpoint/public.json" "$task_dir/public.json"
  cp "$test_author_checkpoint/test-author-result.json" "$task_dir/trajectory/test-author-result.json"
  if [[ -d "$test_author_checkpoint/test-author-trajectory" ]]; then
    rm -rf "$task_dir/trajectory/test-author-$test_author_session_id"
    cp -R "$test_author_checkpoint/test-author-trajectory" "$task_dir/trajectory/test-author-$test_author_session_id"
  fi
}

save_red_green_checkpoint() {
  local temporary="$red_green_checkpoint.$$"
  remove_writable_tree "$temporary"
  mkdir -p "$temporary/workspace" "$temporary/grader"
  rsync -a --checksum --delete "$sandbox_workspace/" "$temporary/workspace/"
  cp "$task_dir/public.json" "$temporary/public.json"
  if [[ -d "$task_dir/grader/model-tests" ]]; then
    mkdir -p "$temporary/grader/model-tests"
    rsync -a --checksum --delete "$task_dir/grader/model-tests/" "$temporary/grader/model-tests/"
  fi
  for artifact in test-author-result.json coverage-preflight.json verification-fast-gate.json; do
    [[ ! -f "$task_dir/trajectory/$artifact" ]] || cp "$task_dir/trajectory/$artifact" "$temporary/$artifact"
  done
  write_checkpoint_metadata "$temporary/checkpoint.json" "red_green_complete" "$session_id" "${test_author_session_id:-}"
  remove_writable_tree "$red_green_checkpoint"
  mv "$temporary" "$red_green_checkpoint"
  find "$red_green_checkpoint" -type f -exec chmod a-w {} +
}

restore_red_green_checkpoint() {
  local metadata="$red_green_checkpoint/checkpoint.json"
  [[ -d "$red_green_checkpoint/workspace" && -s "$red_green_checkpoint/public.json" ]] || return 1
  checkpoint_context_matches "$metadata" || return 1
  [[ "$(jq -r '.session_id // empty' "$metadata")" == "$session_id" ]] || return 1
  rsync -a --checksum --delete "$red_green_checkpoint/workspace/" "$sandbox_workspace/"
  rsync -a --checksum --delete "$red_green_checkpoint/workspace/" "$complete_workspace/"
  rsync -a --checksum --delete "$complete_pristine/" "$sandbox_pristine/"
  cp "$red_green_checkpoint/public.json" "$task_dir/public.json"
  rm -rf "$task_dir/grader/model-tests"
  if [[ -d "$red_green_checkpoint/grader/model-tests" ]]; then
    mkdir -p "$task_dir/grader/model-tests"
    rsync -a --checksum --delete "$red_green_checkpoint/grader/model-tests/" "$task_dir/grader/model-tests/"
  fi
  for artifact in test-author-result.json coverage-preflight.json verification-fast-gate.json; do
    [[ ! -f "$red_green_checkpoint/$artifact" ]] || cp "$red_green_checkpoint/$artifact" "$task_dir/trajectory/$artifact"
  done
  test_author_session_id="$(jq -r '.test_author_session_id // empty' "$metadata")"
}

# Publish a validated workspace without returning to Claude or Docker. Short
# Git transport failures are retried here; the caller retains the checkpoint
# when all attempts fail so a later runner still resumes publication only.
publish_validated_workspace() {
  local validated_workspace="$1"
  local validated_session="$2"
  local max_attempts="${GO_PIPELINE_GIT_PUBLISH_ATTEMPTS:-3}"
  local retry_delay_seconds="${GO_PIPELINE_GIT_PUBLISH_RETRY_DELAY_SECONDS:-5}"
  local attempt_timeout_seconds="${GO_PIPELINE_GIT_PUBLISH_ATTEMPT_TIMEOUT_SECONDS:-600}"
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] || max_attempts=3
  [[ "$retry_delay_seconds" =~ ^[0-9]+$ ]] || retry_delay_seconds=5
  [[ "$attempt_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || attempt_timeout_seconds=600
  [[ -f "$timeout_runner" ]] || { echo "Git publication timeout runner is missing: $timeout_runner" >&2; return 2; }
  # Keep the transport clone outside the per-attempt temporary directory. The
  # publisher is invoked as a new process for each retry, so retaining this
  # cache avoids recloning the repository after a transient Git failure while
  # preserving the exact validated workspace for every publication attempt.
  # Keep it under the task directory so a later scheduler/process retry can
  # reuse the same partial clone as well.
  local publish_cache="$task_dir/.git-publish-cache"
  mkdir -p "$publish_cache"
  local attempt
  local published_commit
  local publish_status=1
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    # Claude runs without user Git/GitHub configuration, but publication is a
    # trusted system phase and must be able to use the operator's credential
    # helper. Drop only the model-isolation overrides for this subprocess.
    if published_commit="$(env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM -u GH_CONFIG_DIR \
      GO_PIPELINE_GIT_PUBLISH_CACHE_DIR="$publish_cache" \
      node "$timeout_runner" "$attempt_timeout_seconds" \
      "$publisher" "$task_dir" "$validated_workspace" "$validated_session")"; then
      rm -rf "$publish_cache" 2>/dev/null || true
      printf '%s\n' "$published_commit"
      return 0
    else
      publish_status=$?
    fi
    echo "validated checkpoint Git publication failed (${attempt}/${max_attempts}); Claude and Docker will not be rerun" >&2
    if [[ "$attempt" -lt "$max_attempts" && "$retry_delay_seconds" -gt 0 ]]; then
      sleep "$retry_delay_seconds"
    fi
  done
  echo "FAILURE_CLASS=git_publication" >&2
  return "$publish_status"
}

# Reuse a fully validated Claude result when only the final Git publication
# failed. The checkpoint contains the exact workspace and transcript for the
# same Session, so this path never starts Claude or consumes a model attempt.
resume_publish_checkpoint() {
  local checkpoint_meta="$publish_checkpoint/checkpoint.json"
  local checkpoint_workspace="$publish_checkpoint/workspace"
  [[ -s "$checkpoint_meta" && -d "$checkpoint_workspace" ]] || return 2
  checkpoint_context_matches "$checkpoint_meta" || { echo "publish checkpoint no longer matches the current prompt or BUG_BASE" >&2; return 2; }
  local checkpoint_session
  checkpoint_session="$(jq -r '.session_id // empty' "$checkpoint_meta")"
  [[ -n "$checkpoint_session" ]] || { echo "publish checkpoint is missing session_id" >&2; return 2; }
  for required in trajectory.stream.jsonl raw.native.jsonl trajectory.jsonl runner-manifest.json; do
    [[ -s "$publish_checkpoint/$required" ]] || { echo "publish checkpoint is missing $required" >&2; return 2; }
  done
  # A clean Claude session legitimately produces an empty mutation audit. It
  # still has to be present so the resumed delivery preserves the exact bundle.
  [[ -f "$publish_checkpoint/mutation-audit.jsonl" ]] || { echo "publish checkpoint is missing mutation-audit.jsonl" >&2; return 2; }
  sync_repository_verification_tests "$checkpoint_workspace" \
    || { echo "publish checkpoint is missing its verified repository acceptance test" >&2; return 2; }
  mark_runner_phase "git_publication"
  echo "resuming validated Claude checkpoint; retrying Git publication for session $checkpoint_session" >&2
  local published_commit
  if ! published_commit="$(publish_validated_workspace "$checkpoint_workspace" "$checkpoint_session")"; then
    echo "validated checkpoint publication failed; keeping checkpoint for the next retry" >&2
    return 1
  fi
  mkdir -p "$task_dir/trajectory"
  cp "$publish_checkpoint/trajectory.stream.jsonl" "$task_dir/trajectory/trajectory.stream.jsonl"
  cp "$publish_checkpoint/raw.native.jsonl" "$task_dir/trajectory/raw.native.${checkpoint_session}.jsonl"
  cp "$publish_checkpoint/trajectory.jsonl" "$task_dir/trajectory/trajectory_${checkpoint_session}.jsonl"
  cp "$publish_checkpoint/mutation-audit.jsonl" "$task_dir/trajectory/mutation-audit.jsonl"
  cp "$publish_checkpoint/runner-manifest.json" "$task_dir/trajectory/runner-manifest.json"
  chmod 0444 \
    "$task_dir/trajectory/trajectory.stream.jsonl" \
    "$task_dir/trajectory/raw.native.${checkpoint_session}.jsonl" \
    "$task_dir/trajectory/trajectory_${checkpoint_session}.jsonl" \
    "$task_dir/trajectory/mutation-audit.jsonl" \
    "$task_dir/trajectory/runner-manifest.json"
  printf '%s\n' "$checkpoint_session" >"$task_dir/trajectory/session_id.txt"
  printf '%s\n' "$(shasum -a 256 "$task_dir/trajectory/trajectory.stream.jsonl" | awk '{print $1}')" >"$task_dir/trajectory/raw.sha256"
  printf '%s\n' "$(stat -f '%z' "$task_dir/trajectory/trajectory.stream.jsonl")" >"$task_dir/trajectory/raw.bytes"
  # The retry workspace may contain same-size files with preserved mtimes from
  # pristine. Compare content so the published, validated checkpoint wins.
  rsync -a --checksum --delete "$checkpoint_workspace/" "$workspace/"
  save_post_fix_checkpoint "$published_commit" "$checkpoint_session"
  remove_writable_tree "$publish_checkpoint"
  remove_writable_tree "$repair_checkpoint"
  remove_writable_tree "$test_author_checkpoint"
  remove_writable_tree "$red_green_checkpoint"
  workspace_committed=1
  echo "published validated checkpoint commit $published_commit" >&2
}

if [[ -s "$publish_checkpoint/checkpoint.json" ]]; then
  if resume_publish_checkpoint; then
    exit 0
  else
    checkpoint_status=$?
    [[ "$checkpoint_status" -eq 2 ]] || exit "$checkpoint_status"
    echo "ignoring incomplete publish checkpoint; starting a fresh Claude run" >&2
  fi
fi

resumed_repair_checkpoint=0
resumed_test_author_checkpoint=0
resumed_red_green_checkpoint=0
if restore_repair_checkpoint; then
  resumed_repair_checkpoint=1
  mark_runner_phase "claude_repair_checkpoint_restored"
  echo "resuming completed Claude repair checkpoint for session $session_id" >&2
  # The immutable repair checkpoint intentionally predates the Codex test.
  # Preserve the already-authored repository test when resuming only Docker
  # and Git publication.
  if [[ "$post_claude_codex_flow" -eq 0 && "$(jq -r '.verification_test_overlay // "none"' "$task_dir/public.json")" == "repository-tests" ]]; then
    while IFS= read -r test_file; do
      [[ -n "$test_file" && -f "$workspace/$test_file" ]] || continue
      mkdir -p "$sandbox_workspace/$(dirname "$test_file")"
      cp "$workspace/$test_file" "$sandbox_workspace/$test_file"
    done < <(jq -r '.verification_test_files[]? // empty' "$task_dir/public.json")
  fi
  if [[ "$new_private_fixture_flow" -eq 0 ]] && restore_red_green_checkpoint; then
    resumed_red_green_checkpoint=1
    resumed_test_author_checkpoint=1
    mark_runner_phase "red_green_checkpoint_restored"
    echo "resuming completed red/green checkpoint for session $session_id" >&2
  elif [[ "$new_private_fixture_flow" -eq 0 ]] && restore_test_author_checkpoint; then
    resumed_test_author_checkpoint=1
    mark_runner_phase "test_author_checkpoint_restored"
    echo "resuming completed independent-test checkpoint for session $session_id" >&2
  fi
else
  remove_writable_tree "$repair_checkpoint"
  if ! checkpoint_context_matches "$test_author_checkpoint/checkpoint.json"; then
    remove_writable_tree "$test_author_checkpoint"
  fi
  remove_writable_tree "$red_green_checkpoint"
fi

if [[ "$resumed_repair_checkpoint" -eq 0 ]]; then
mkdir -p "$hook_runtime/scripts" "$hook_runtime/src"
cp "$runner_root/package.json" "$hook_runtime/package.json"
cp "$audit_hook_source" "$hook_runtime/scripts/claude-v4-hook.mjs"
cp "$runner_root/src/trajectory-audit.js" "$hook_runtime/src/trajectory-audit.js"
cp "$runner_root/src/trajectory-file-validator.js" "$hook_runtime/src/trajectory-file-validator.js"
cp "$runner_root/src/trajectory-v4.js" "$hook_runtime/src/trajectory-v4.js"
audit_hook="$hook_runtime/scripts/claude-v4-hook.mjs"
: >"$audit_log"
printf -v hook_command '%q %q' "$node_bin" "$audit_hook"
jq -n --arg command "$hook_command" '{
  hooks: {
    PreToolUse: [{matcher: "Bash|Edit|Write|NotebookEdit|MultiEdit|apply_patch|ApplyPatch", hooks: [{type: "command", command: $command, timeout: 30}]}],
    PostToolUse: [{matcher: "Bash|Edit|Write|NotebookEdit|MultiEdit|apply_patch|ApplyPatch", hooks: [{type: "command", command: $command, timeout: 30}]}],
    PostToolUseFailure: [{matcher: "Bash|Edit|Write|NotebookEdit|MultiEdit|apply_patch|ApplyPatch", hooks: [{type: "command", command: $command, timeout: 30}] }]
  }
}' >"$hook_settings"
printf '%s\n' '{"hook_event_name":"V4Baseline"}' | "$node_bin" "$audit_hook"
append_system_prompt="Work only on the user request inside the provided isolated workspace. Ordinary production source, pre-existing tests and testdata, project documentation, build scripts, Dockerfiles, and public commands are available engineering context. Start from the concrete endpoint, CLI action, error, log, stack trace, or state difference stated by the user. Use rg, go list, and other ordinary source-navigation tools to find that public entry point and follow its direct call chain; avoid surveying unrelated packages. Run only an explicitly public reproduction from the user request or a focused pre-existing package or test. Do not run broad go test ./..., go vet ./..., go build ./..., Docker, or broad repository scans in this task Session; the pipeline performs those broad checks independently after the model task. Do not author any new bug-specific test, TestModel_ test, helper, script, or fixture. Do not run Git or GitHub commands or inspect Git history. Do not search outside the isolated workspace, clone code, or inspect Gold, grader, hidden-test, solution, answer, patch, pipeline, task metadata, archived-attempt, rejected-attempt, trajectory, prompt, preset-test, verification-material, or private-fixture paths. Do not read or write verify_cmds or any answer-bearing material. You may run focused ordinary Go tests, focused package builds, and public reproduction commands; do not use wrappers that expose Gold, grader, hidden tests, verify_cmds, or private fixtures."
if [[ "$task_type" == "diagnosis" ]]; then
  append_system_prompt+=" This is a read-only diagnosis task. Investigate the reported behavior and provide an evidence-based conclusion without modifying any file. The workspace is intentionally read-only. Once the implementation cause is located, stop and report the relevant call chain, state transition, and root cause; do not attempt a fix. Never invoke Edit, Write, NotebookEdit, shell redirection, chmod, or any other file-mutation command."
else
  append_system_prompt+=" This is a bugfix task. After locating the implementation cause, make the smallest appropriate production fix requested by the user; do not stop after diagnosis or merely suggest a patch, because a Session with no non-test workspace change is rejected. Add or run a focused regression test only when that test already exists in the workspace; never create a new TestModel_ or other bug-specific test."
fi
prompt="$(<"$prompt_file")"
claude_effort="${CLAUDE_EFFORT:-low}"
if [[ -z "${CLAUDE_EFFORT:-}" && "$task_type" == "bugfix" ]]; then
  claude_effort="medium"
fi

cd "$sandbox_workspace"
disallowed_tools=(
  "Bash(git *)" "Bash(gh *)" "Bash(ssh *)" "Bash(scp *)"
  "Bash(*verify_cmds*)" "Bash(*grader*)" "Bash(*gold*)" "Bash(*hidden*)"
  "Bash(*solution*)" "Bash(*answer*)" "Bash(*patch*)"
  "Bash(*go test ./...*)" "Bash(*go vet ./...*)" "Bash(*go build ./...*)"
  "Bash(docker *)" "Bash(* docker *)"
)
if [[ "$task_type" == "diagnosis" ]]; then
  # Diagnosis is read-only. Claude can still access Bash for the public
  # reproduction command, so block common shell write paths explicitly; the
  # generic Edit/Write denial alone does not stop sed/python/chmod redirection.
  disallowed_tools+=(
    Edit Write NotebookEdit
    'Bash(*sed*)' 'Bash(*perl*)' 'Bash(*python*)' 'Bash(*ruby*)'
    'Bash(*node *)' 'Bash(*chmod*)' 'Bash(*chown*)' 'Bash(*touch*)'
    'Bash(*tee*)' 'Bash(*cp *)' 'Bash(*mv *)' 'Bash(*rm *)'
    'Bash(* > *)' 'Bash(* >> *)' 'Bash(cat >*)' 'Bash(cat >>*)'
  )
  chmod -R a-w "$sandbox_workspace"
fi
model_args=()
if [[ -n "$claude_model" ]]; then
  model_args=(--model "$claude_model")
fi
claude_command=("$claude_bin" \
  --print \
  --verbose \
  --effort "$claude_effort" \
  --output-format stream-json \
  "${model_args[@]}" \
  --append-system-prompt "$append_system_prompt" \
  --settings "$hook_settings" \
  --setting-sources "" \
  --disable-slash-commands \
  --disallowedTools "${disallowed_tools[@]}" \
  --permission-mode bypassPermissions \
  --allow-dangerously-skip-permissions \
  --dangerously-skip-permissions \
  -p "$prompt")
if [[ -x /usr/bin/sandbox-exec ]]; then
  workspace_write_rule=""
  if [[ "$task_type" == "diagnosis" ]]; then
    workspace_write_rule="(deny file-write* (subpath \"$sandbox_workspace\"))"
  fi
  sandbox_profile="(version 1)
(allow default)
(deny file-read* (subpath \"$project_root\"))
(allow file-read* (subpath \"$work_root/toolchains\"))
(deny file-write* (subpath \"$project_root\"))
(deny file-read* (subpath \"$HOME/.claude\"))
(deny file-read* (literal \"$HOME/.claude.json\"))
(deny file-read* (subpath \"$HOME/.codex\"))
(deny file-read* (subpath \"$HOME/.config/gh\"))
$workspace_write_rule"
  claude_command=(/usr/bin/sandbox-exec -p "$sandbox_profile" "${claude_command[@]}")
elif command -v bwrap >/dev/null 2>&1; then
  bubblewrap_command=(
    "$(command -v bwrap)"
    --die-with-parent --new-session
    --ro-bind / /
    --dev-bind /dev /dev
    --proc /proc
    --bind "$run_root" "$run_root"
    --tmpfs "$project_root"
  )
  if [[ -d "$work_root/toolchains" ]]; then
    bubblewrap_command+=(--dir "$work_root" --ro-bind "$work_root/toolchains" "$work_root/toolchains")
  fi
  for hidden_dir in "$HOME/.claude" "$HOME/.codex" "$HOME/.config/gh"; do
    [[ -d "$hidden_dir" ]] && bubblewrap_command+=(--tmpfs "$hidden_dir")
  done
  if [[ -f "$HOME/.claude.json" ]]; then
    bubblewrap_command+=(--ro-bind /dev/null "$HOME/.claude.json")
  fi
  claude_command=("${bubblewrap_command[@]}" -- "${claude_command[@]}")
else
  echo "Claude repair requires sandbox-exec (macOS) or bubblewrap (Linux); refusing to run without filesystem read isolation" >&2
  exit 79
fi
mark_runner_phase "source_locating"
start_progress_watcher
claude_pipeline_parent_pid="$$"
set +e
"${claude_command[@]}" 2>"$sandbox_stderr" \
  | tee "$sandbox_raw" \
  | while IFS= read -r line; do
      if ! record_stream_activity "$line"; then
        echo "Claude permission denial guard reached (${permission_denial_stop_reason}); terminating Session" >&2
        terminate_claude_pipeline_siblings "$claude_pipeline_parent_pid"
        exit 86
      fi
      printf 'CLAUDE_PROGRESS\n'
    done
pipeline_status=("${PIPESTATUS[@]}")
claude_exit="${pipeline_status[0]}"
if [[ "${pipeline_status[2]:-0}" -eq 86 ]]; then
  claude_exit=86
fi
set -e
cp "$sandbox_stderr" "$stderr"
if [[ "$claude_exit" -ne 0 ]]; then
  api_retry_summary="$(jq -sr '
    map(select(.type == "system" and .subtype == "api_retry")) | last // null |
    if . == null then empty
    else "Claude API Error: \(.error_status // "unknown") \(.error // .error_type // "api_retry") (attempt \(.attempt // "?")/\(.max_retries // "?"))"
    end
  ' "$sandbox_raw" 2>/dev/null || true)"
  if [[ -n "$api_retry_summary" ]]; then
    printf '%s\n' "$api_retry_summary" >&2
  fi
  if /usr/bin/grep -Eq 'EPERM: operation not permitted, fstat|process\.stderr\.fd' "$sandbox_stderr"; then
    echo "Claude CLI sandbox output initialization failed; stderr must stay inside the isolated temp directory" >&2
  else
    tail -c 6000 "$sandbox_stderr" >&2
  fi
  exit "$claude_exit"
fi
printf '%s\n' '{"hook_event_name":"V4Final"}' | "$node_bin" "$audit_hook"
mark_runner_phase "claude_capture_finalize"
actual_model="$(jq -r 'select(.type == "system" and .subtype == "init") | .model // empty' "$sandbox_raw" | head -n 1)"
if [[ "$actual_model" != "$claude_model" ]]; then
  echo "Claude Bug 修复模型不匹配：期望 $claude_model，实际 ${actual_model:-未报告}" >&2
  exit 78
fi
mv "$sandbox_raw" "$raw"

session_id="$(jq -r 'select(.type == "result") | .session_id' "$raw" | tail -n 1)"
if [[ -z "$session_id" || "$session_id" == "null" ]]; then
  echo "missing result session id" >&2
  exit 4
fi
init_count="$(jq -s '[.[] | select(.type == "system" and .subtype == "init")] | length' "$raw")"
result_count="$(jq -s '[.[] | select(.type == "result")] | length' "$raw")"
success_count="$(jq -s '[.[] | select(.type == "result" and .subtype == "success" and .is_error == false)] | length' "$raw")"
retry_count="$(jq -s '[.[] | select(.type == "system" and .subtype == "api_retry")] | length' "$raw")"
claude_code_version="$(jq -rs '[.[] | select(.type == "system" and .subtype == "init") | .claude_code_version | select(type == "string" and length > 0)] | unique | if length == 1 then .[0] else "" end' "$raw")"
if [[ "$init_count" -ne 1 || "$result_count" -ne 1 || "$success_count" -ne 1 ]]; then
  invalid="$task_dir/trajectory/trajectory.stream.${session_id}.incomplete.jsonl"
  mv "$raw" "$invalid"
  echo "invalid trajectory: init=$init_count result=$result_count success=$success_count retries=$retry_count; saved as $invalid" >&2
  exit 5
fi
if [[ "$task_type" == "bugfix" ]] \
  && ! bugfix_workspace_has_non_test_change "$sandbox_pristine" "$sandbox_workspace"; then
  echo "INVALID_REPAIR_OUTPUT=1" >&2
  echo "bugfix Claude Session completed without a non-test workspace patch" >&2
  exit 43
fi
if [[ ! "$claude_code_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid or missing Claude Code CLI version in system/init: $claude_code_version" >&2
  exit 5
fi

native_source="$(find "$CLAUDE_CONFIG_DIR/projects" -type f -name "${session_id}.jsonl" -print -quit 2>/dev/null || true)"
if [[ -z "$native_source" || ! -s "$native_source" ]]; then
  echo "missing Claude native transcript for session $session_id" >&2
  exit 9
fi
native_session_count="$(jq -s --arg sid "$session_id" '[.[] | select((.sessionId // .session_id // "") == $sid)] | length' "$native_source")"
native_user_count="$(jq -s '[.[] | select(.type == "user")] | length' "$native_source")"
native_assistant_count="$(jq -s '[.[] | select(.type == "assistant")] | length' "$native_source")"
native_last_prompt_count="$(jq -s '[.[] | select(.type == "last-prompt")] | length' "$native_source")"
if [[ "$native_session_count" -lt 1 || "$native_user_count" -lt 1 || "$native_assistant_count" -lt 1 || "$native_last_prompt_count" -lt 1 ]]; then
  echo "incomplete Claude native transcript: session=$native_session_count user=$native_user_count assistant=$native_assistant_count last_prompt=$native_last_prompt_count" >&2
  exit 9
fi
cp "$native_source" "$native_candidate"
raw_native_candidate="$run_root/raw.native.${session_id}.jsonl"
mv "$native_candidate" "$raw_native_candidate"
native_candidate="$raw_native_candidate"
canonical_candidate="$run_root/trajectory_${session_id}.jsonl"
go_version_output="$(go version)"
node "$canonical_exporter" \
  "--native=$native_candidate" \
  "--stream=$raw" \
  "--prompt=$prompt_file" \
  "--audit=$audit_log" \
  "--output=$canonical_candidate" \
  "--manifest=$manifest_candidate" \
  "--task-type=$task_type" \
  "--go-version=$go_version_output" >/dev/null
if [[ "$task_type" == "diagnosis" ]]; then
  : >"$validation_log"
  if ! diff -qr --exclude='.git' "$sandbox_pristine" "$sandbox_workspace" >"$validation_log" 2>&1; then
    echo "diagnosis modified the isolated workspace; rejecting the Session before checkpoint save" >&2
    remove_writable_tree "$repair_checkpoint"
    exit 44
  fi
  if ! "$node_bin" "$diagnosis_readonly_checker" "$native_candidate" "$audit_log" "$sandbox_workspace"; then
    echo "diagnosis trajectory contains a file or persistent-configuration write attempt; rejecting the Session before checkpoint save" >&2
    remove_writable_tree "$repair_checkpoint"
    exit 44
  fi
fi
save_repair_checkpoint
mark_runner_phase "claude_repair_checkpoint_saved"
fi

if [[ "$post_claude_codex_flow" -eq 1 || "$task_type" == "diagnosis" ]]; then
  rsync -a --checksum --delete "$sandbox_workspace/" "$workspace/"
  cp "$raw" "$task_dir/trajectory/trajectory.stream.jsonl"
  cp "$native_candidate" "$task_dir/trajectory/raw.native.${session_id}.jsonl"
  cp "$canonical_candidate" "$task_dir/trajectory/trajectory_${session_id}.jsonl"
  cp "$audit_log" "$task_dir/trajectory/mutation-audit.jsonl"
  cp "$manifest_candidate" "$task_dir/trajectory/runner-manifest.json"
  printf '%s\n' "$session_id" >"$task_dir/trajectory/session_id.txt"
  workspace_committed=1
  if [[ "$task_type" == "diagnosis" ]]; then
    mark_runner_phase "diagnosis_repair_checkpoint_saved"
    echo "Claude diagnosis checkpoint complete; skipping Docker/Git repair delivery" >&2
  else
    mark_runner_phase "awaiting_codex_test_author"
    echo "Claude repair checkpoint complete; awaiting independent Codex acceptance test author" >&2
  fi
  exit 0
fi

pretest_trajectory_dir="$task_dir/trajectory"
cp "$raw" "$pretest_trajectory_dir/trajectory.stream.jsonl"
cp "$native_candidate" "$pretest_trajectory_dir/raw.native.${session_id}.jsonl"
cp "$canonical_candidate" "$pretest_trajectory_dir/trajectory_${session_id}.jsonl"
cp "$audit_log" "$pretest_trajectory_dir/mutation-audit.jsonl"
cp "$manifest_candidate" "$pretest_trajectory_dir/runner-manifest.json"

request_phase_resource "docker_validation"
# Keep the repair workspace free of the private verification fixture. The
# fixture is overlaid into a disposable validation copy below and into the
# delivery branches only after this Session has ended.
remove_generated_compiler_artifacts "$sandbox_workspace" "$sandbox_pristine" "$validation_log"
sync_repository_verification_tests "$sandbox_workspace" \
  || { echo "REUSABLE_TEST_AUTHOR_CHECKPOINT=1" >&2; exit 6; }
rsync -a --checksum --delete "$sandbox_workspace/" "$workspace/"

: >"$validation_log"
if [[ -f "$task_dir/grader/v4-context.json" ]]; then
  gold_test_name="$(jq -r '.gold_test_name // empty' "$task_dir/grader/v4-context.json")"
  if [[ -n "$gold_test_name" ]]; then
    collision_result="$(node "$grader_collision_checker" "$task_dir" "$workspace" 2>&1)" || {
      echo "$collision_result" >&2
      exit 42
    }
    printf 'grader preflight: %s\n' "$collision_result" >>"$validation_log"
  elif [[ "$workflow_version" -lt 3 ]]; then
    echo "legacy task has no gold_test_name in grader context" >&2
    exit 42
  else
    printf 'grader preflight: skipped (Claude-only workflow has no Gold test)\n' >>"$validation_log"
  fi
fi
printf '$ %q %q %q %q\n' "$docker_grader" "$task_dir" "$workspace" "$task_type" >>"$validation_log"
mark_runner_phase "docker_validation"
docker_workspace="$workspace"
verification_overlay="$(jq -r '.verification_test_overlay // "none"' "$task_dir/public.json")"
if [[ "$verification_overlay" == "private-fixture" ]]; then
  docker_workspace="$run_root/validation-workspace"
  rsync -a --checksum --delete "$workspace/" "$docker_workspace/"
  fixture_dir="$(jq -r '.verification_fixture_dir // empty' "$task_dir/public.json")"
  fixture_file="$(jq -r '.verification_test_files[0] // empty' "$task_dir/public.json")"
  [[ -n "$fixture_dir" && -n "$fixture_file" && "$fixture_file" != /* && "$fixture_file" != *..* ]] \
    || { echo "private verification fixture metadata is invalid" >&2; exit 6; }
  [[ -f "$fixture_dir/$fixture_file" ]] || { echo "private verification fixture is missing: $fixture_file" >&2; exit 6; }
  mkdir -p "$docker_workspace/$(dirname "$fixture_file")"
  cp "$fixture_dir/$fixture_file" "$docker_workspace/$fixture_file"
  printf 'private fixture overlay: %s\n' "$fixture_file" >>"$validation_log"
fi
printf '$ %q %q %q %q\n' "$docker_grader" "$task_dir" "$docker_workspace" "$task_type" >>"$validation_log"
if ! "$docker_grader" "$task_dir" "$docker_workspace" "$task_type" 2>&1 | tee -a "$validation_log"; then
  echo "Docker system-side acceptance failed; see $validation_log" >&2
  tail -c 6000 "$validation_log" >&2 || true
  if /usr/bin/grep -Eqi 'error waiting for container:[[:space:]]*unexpected EOF|Cannot connect to the Docker daemon|Docker daemon|Docker Desktop|context deadline exceeded|TLS handshake timeout|error during connect|no space left on device|connection reset by peer|unable to lease content|lease does not exist' "$validation_log"; then
    # A Docker outage can happen after the grader has printed a deterministic
    # FAILURE_CLASS. Infrastructure evidence takes precedence so a validated
    # Claude repair is retained and only system-side acceptance is retried.
    if [[ "$new_private_fixture_flow" -eq 1 ]]; then
      remove_writable_tree "$red_green_checkpoint"
      echo "REUSABLE_REPAIR_CHECKPOINT=1" >&2
    elif [[ "$task_type" == "bugfix" ]]; then
      echo "REUSABLE_RED_GREEN_CHECKPOINT=1" >&2
    else
      echo "REUSABLE_REPAIR_CHECKPOINT=1" >&2
    fi
  elif /usr/bin/grep -Eq 'FAILURE_CLASS=(public_compile|hidden_target|public_target|public_full|public_static)' "$validation_log"; then
    # A broad deterministic gate proved that the repair itself is invalid.
    # Drop every downstream checkpoint so the next attempt starts from
    # pristine source instead of replaying the same broken workspace.
    remove_writable_tree "$repair_checkpoint"
    remove_writable_tree "$test_author_checkpoint"
    remove_writable_tree "$red_green_checkpoint"
    remove_writable_tree "$publish_checkpoint"
    echo "INVALID_REPAIR_CHECKPOINT=1" >&2
  elif [[ "$new_private_fixture_flow" -eq 1 ]]; then
    # The Claude repair checkpoint and Codex-authored test are immutable. A
    # Docker infrastructure failure retries validation/publication from that
    # checkpoint and never spends another Claude repair attempt.
    remove_writable_tree "$red_green_checkpoint"
    echo "REUSABLE_REPAIR_CHECKPOINT=1" >&2
  elif [[ "$task_type" == "bugfix" ]]; then
    echo "REUSABLE_RED_GREEN_CHECKPOINT=1" >&2
  else
    echo "REUSABLE_REPAIR_CHECKPOINT=1" >&2
  fi
  exit 7
fi
docker_grader_used=1
mark_runner_phase "package_validation"

if [[ "$docker_grader_used" -eq 1 ]]; then
  toolchain_patch="$(go env GOVERSION)"
  if [[ "$workflow_version" -ge 3 ]]; then
    docker_harness="backend=docker-target; isolation=independent-workspace-without-.git + system-side-public-model-grader; platform=linux/arm64,linux/amd64; container_network=none; target_cli=Claude Code CLI; target_cli_version=$claude_code_version (Claude Code); go=$toolchain_patch; public_target_runs=2/2"
  else
    docker_harness="backend=docker-target; isolation=independent-workspace-without-.git + read-only-external-hidden-grader; platform=linux/arm64,linux/amd64; container_network=none; target_cli=Claude Code CLI; target_cli_version=$claude_code_version (Claude Code); go=$toolchain_patch; hidden_target_runs=20/20"
  fi
  public_tmp="$(mktemp "$task_dir/.public.json.docker.XXXXXX")"
  jq --arg harness "$docker_harness" '.harness = $harness' "$task_dir/public.json" >"$public_tmp"
  mv "$public_tmp" "$task_dir/public.json"
fi

# Runtime smoke validation may compile a helper in either the repair workspace
# or the Docker validation copy. These binaries are execution residue, not
# source deliverables, so remove only files that did not exist in BUG_BASE.
remove_generated_compiler_artifacts "$sandbox_workspace" "$sandbox_pristine" "$validation_log"
remove_generated_compiler_artifacts "$workspace" "$sandbox_pristine" "$validation_log"
if [[ "$docker_workspace" != "$workspace" ]]; then
  remove_generated_compiler_artifacts "$docker_workspace" "$sandbox_pristine" "$validation_log"
fi

validator_args=("--baseline=$sandbox_pristine" "$docker_workspace")
if [[ "$docker_grader_used" -eq 1 ]]; then
  validator_args=(--static-only "--baseline=$sandbox_pristine" "$docker_workspace")
fi
  if ! node "$project_validator" "${validator_args[@]}" >"$project_validation_log" 2>&1; then
    echo "Git project packaging validation failed; see $project_validation_log" >&2
    remove_writable_tree "$publish_checkpoint"
    # Packaging validation is downstream of the semantic red/green and Docker
    # gates. Preserve the trusted repair so a retry cannot spend another model
    # attempt for an export-only failure.
    if [[ "$new_private_fixture_flow" -eq 1 ]]; then
      echo "REUSABLE_REPAIR_CHECKPOINT=1" >&2
    elif [[ "$task_type" == "bugfix" ]]; then
      echo "REUSABLE_RED_GREEN_CHECKPOINT=1" >&2
    else
      echo "REUSABLE_REPAIR_CHECKPOINT=1" >&2
    fi
    exit 8
  fi

save_publish_checkpoint() {
  local temporary="$publish_checkpoint.$$"
  remove_writable_tree "$temporary"
  remove_generated_compiler_artifacts "$sandbox_workspace" "$sandbox_pristine" "$validation_log"
  mkdir -p "$temporary/workspace"
  rsync -a --checksum --delete "$sandbox_workspace/" "$temporary/workspace/"
  cp "$raw" "$temporary/trajectory.stream.jsonl"
  cp "$native_candidate" "$temporary/raw.native.jsonl"
  cp "$canonical_candidate" "$temporary/trajectory.jsonl"
  cp "$audit_log" "$temporary/mutation-audit.jsonl"
  cp "$manifest_candidate" "$temporary/runner-manifest.json"
  write_checkpoint_metadata "$temporary/checkpoint.json" "docker_complete" "$session_id" "${test_author_session_id:-}"
  remove_writable_tree "$publish_checkpoint"
  mv "$temporary" "$publish_checkpoint"
  find "$publish_checkpoint" -type f -exec chmod a-w {} +
}

# Docker and package validation are complete. Persist the exact workspace before
# network-dependent publication; this is the fourth immutable stage checkpoint.
save_publish_checkpoint
mark_runner_phase "docker_checkpoint_saved"
request_phase_resource "git_publication"

mark_runner_phase "git_publication"
test_model_commit="$(publish_validated_workspace "$sandbox_workspace" "$session_id")"

mv "$raw" "$task_dir/trajectory/trajectory.stream.jsonl"
mv "$native_candidate" "$task_dir/trajectory/raw.native.${session_id}.jsonl"
mv "$canonical_candidate" "$task_dir/trajectory/trajectory_${session_id}.jsonl"
mv "$audit_log" "$task_dir/trajectory/mutation-audit.jsonl"
mv "$manifest_candidate" "$task_dir/trajectory/runner-manifest.json"
chmod 0444 \
  "$task_dir/trajectory/trajectory.stream.jsonl" \
  "$task_dir/trajectory/raw.native.${session_id}.jsonl" \
  "$task_dir/trajectory/trajectory_${session_id}.jsonl" \
  "$task_dir/trajectory/mutation-audit.jsonl" \
  "$task_dir/trajectory/runner-manifest.json"
printf '%s\n' "$session_id" > "$task_dir/trajectory/session_id.txt"
printf '%s\n' "$(shasum -a 256 "$task_dir/trajectory/trajectory.stream.jsonl" | awk '{print $1}')" > "$task_dir/trajectory/raw.sha256"
printf '%s\n' "$(stat -f '%z' "$task_dir/trajectory/trajectory.stream.jsonl")" > "$task_dir/trajectory/raw.bytes"
workspace_committed=1
save_post_fix_checkpoint "$test_model_commit" "$session_id"
mark_runner_phase "git_publication_complete"
remove_writable_tree "$publish_checkpoint"
remove_writable_tree "$repair_checkpoint"
remove_writable_tree "$test_author_checkpoint"
remove_writable_tree "$red_green_checkpoint"
printf '%s %s\n' "$session_id" "$test_model_commit"
