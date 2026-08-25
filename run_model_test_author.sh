#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 TASK_DIR SOURCE_WORKSPACE PROMPT_FILE REPAIR_SESSION_ID" >&2
  exit 2
fi

task_dir="$(cd "$1" && pwd)"
source_workspace="$(cd "$2" && pwd)"
prompt_file="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")"
repair_session_id="$4"
claude_bin="${GO_PIPELINE_CLAUDE_BIN:-/Users/niuyuhang/.npm-global/bin/claude}"
runner_root="${GO_PIPELINE_MONITOR_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
run_root="$(mktemp -d "${TMPDIR:-/tmp}/go-task-test-author.XXXXXX")"
sandbox_workspace="$run_root/workspace"
before_workspace="$run_root/before"
raw_stream="$run_root/raw.stream.jsonl"
stderr_log="$run_root/claude.stderr.log"
export CLAUDE_CONFIG_DIR="$run_root/claude-config"
mkdir -p "$sandbox_workspace" "$before_workspace" "$CLAUDE_CONFIG_DIR"
cp -R "$source_workspace/." "$sandbox_workspace/"
cp -R "$source_workspace/." "$before_workspace/"
# The test author may inspect the complete ordinary repository context,
# including existing tests and project documentation. Keep answer-bearing,
# bug-specific reproduction, and history-bearing material outside the sandbox.
prune_forbidden_material() {
  local root="$1"
  find "$root" -type d \( \
    -name '.git' -o -name 'grader' -o -name 'gold' -o -name 'hidden-tests' \
    -o -name 'hidden_tests' -o -name 'solutions' -o -name 'answers' \
    -o -name 'patches' -o -name 'trajectory' \
  \) -prune -exec rm -rf {} +
  # File names are part of the protected boundary too. A public source tree
  # may contain ordinary tests and docs, but answer-bearing artifacts must
  # never be exposed to the independent test-authoring Session.
  find "$root" -type f \( \
    -iname 'BUG_REPRO*' -o \
    -iname '*verify_cmds*' -o -iname '*gold*' -o -iname '*grader*' \
    -o -iname '*hidden_test*' -o -iname '*solution*' -o -iname '*answer*' \
    -o -iname '*patch*' -o -iname '*trajectory*' \
  \) -delete
}
prune_forbidden_material "$sandbox_workspace"
prune_forbidden_material "$before_workspace"

cleanup() {
  chmod -R u+w "$run_root" 2>/dev/null || true
  rm -rf "$run_root" || true
}
trap cleanup EXIT

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

export GOTOOLCHAIN=local
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export GOSUMDB="${GOSUMDB:-off}"
export GOCACHE="$run_root/gocache"
export GOMODCACHE="$run_root/gomodcache"
export GOTMPDIR="$run_root/gotmp"
export TMPDIR="$GOTMPDIR"
mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOTMPDIR"

# The author receives the repaired source after the repair Session completes.
# Keep the source workspace outside the Claude sandbox;
# only changed *_test.go files are copied back below.

user_query="$(<"$prompt_file")"
focus_files=()
if [[ -d "$task_dir/pristine" ]]; then
  while IFS= read -r file; do
    relative="${file#"$source_workspace/"}"
    [[ -f "$task_dir/pristine/$relative" ]] && cmp -s "$file" "$task_dir/pristine/$relative" && continue
    focus_files+=("$relative")
  done < <(find "$source_workspace" -type f -name '*.go' ! -name '*_test.go' -print)
fi
focus_text="$(printf '%s\n' "${focus_files[@]}" | awk 'NF && !seen[$0]++' | head -n 12)"
if [[ -n "$focus_text" ]]; then
  focus_guidance=$(cat <<EOF
The repaired production files are listed below. Start with these files and their nearest existing *_test.go harnesses; do not survey unrelated packages unless compilation requires it:
$focus_text
EOF
)
else
  focus_guidance="Start with the package and nearest existing *_test.go harness named by the user report; do not survey unrelated packages unless compilation requires it."
fi
author_prompt=$(cat <<EOF
The repair Session has already completed. You are a separate public-test authoring Session.

User report:
$user_query

$focus_guidance

Add exactly one repository-owned focused Go regression test function whose name starts with TestModel_. Put all required scenarios into table cases inside that one function and execute them with t.Run so the complete user report remains covered without creating a broad suite. Change exactly one *_test.go file and reuse the nearest existing harness instead of rebuilding project setup. Do not change production source, build configuration, documentation, scripts, or metadata. Run only that exact TestModel_ function and, only when necessary, a compile-only check for its target package. Never run go test ./..., multiple packages, -race, go vet ./..., go build ./..., Docker, or architecture validation; the pipeline performs those broader checks afterward. You are not given the unmodified BUG_BASE and must not try to reconstruct or locate it; after this Session, the system independently runs the exact test against BUG_BASE and requires it to fail. Do not inspect Git history, task metadata, grader, Gold, trajectories, or external paths.
EOF
)

cd "$sandbox_workspace"
author_effort="${GO_PIPELINE_TEST_AUTHOR_EFFORT:-low}"
claude_command=("$claude_bin" --print --verbose --effort "$author_effort" --output-format stream-json --model "$claude_model" --setting-sources "" --disable-slash-commands --disallowedTools "Bash(git *)" "Bash(gh *)" "Bash(ssh *)" "Bash(scp *)" "Bash(*go test ./...*)" "Bash(*-race*)" "Bash(*go vet ./...*)" "Bash(*go build ./...*)" "Bash(docker *)" Task WebFetch WebSearch --permission-mode bypassPermissions --allow-dangerously-skip-permissions --dangerously-skip-permissions -p "$author_prompt")
if [[ -x /usr/bin/sandbox-exec ]]; then
  sandbox_profile="(version 1)
(allow default)
(deny file-read* (subpath \"$task_dir\"))
(deny file-read* (subpath \"$HOME/.claude\"))
(deny file-read* (literal \"$HOME/.claude.json\"))
(deny file-read* (subpath \"$HOME/.codex\"))
(deny file-write* (subpath \"$task_dir\"))"
  claude_command=(/usr/bin/sandbox-exec -p "$sandbox_profile" "${claude_command[@]}")
fi
set +e
# Keep the parent runner informed while the authoring Session is thinking.
# Progress is sent on stderr because stdout is reserved for the final JSON
# result consumed by run_one_claude.sh.
"${claude_command[@]}" 2>"$stderr_log" \
  | tee "$raw_stream" \
  | while IFS= read -r _line; do
      printf 'CLAUDE_TEST_AUTHOR_PROGRESS\n' >&2
    done
claude_exit="${PIPESTATUS[0]}"
set -e
[[ "$claude_exit" -eq 0 ]] || { tail -c 6000 "$stderr_log" >&2 || true; exit "$claude_exit"; }

# Keep the jq filter in a double-quoted shell argument.  The test-author
# runner is also used with the system Bash 3.2 on macOS; avoiding nested single
# quote parsing here prevents an otherwise misleading exit=2 before the
# returned Claude stream is inspected.
session_id="$(jq -r "select(.type == \"result\") | .session_id" "$raw_stream" | tail -n 1)"
[[ "$session_id" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "missing test-author Session UUID" >&2; exit 6; }
native_source="$(find "$CLAUDE_CONFIG_DIR/projects" -type f -name "${session_id}.jsonl" -print -quit 2>/dev/null || true)"
[[ -s "$native_source" ]] || { echo "missing test-author native transcript" >&2; exit 7; }

if ! diff -qr --exclude='*_test.go' --exclude='.git' "$before_workspace" "$sandbox_workspace" >/dev/null 2>&1; then
  echo "test-author Session modified a non-test file" >&2
  exit 8
fi
test_files=()
while IFS= read -r file; do
  relative="${file#"$sandbox_workspace/"}"
  if [[ ! -f "$before_workspace/$relative" ]] || ! cmp -s "$file" "$before_workspace/$relative"; then
    test_files+=("$relative")
  fi
done < <(find "$sandbox_workspace" -type f -name '*_test.go' -print)
while IFS= read -r file; do
  relative="${file#"$before_workspace/"}"
  [[ -f "$sandbox_workspace/$relative" ]] || test_files+=("$relative")
done < <(find "$before_workspace" -type f -name '*_test.go' -print)
test_files_text="$(printf '%s\n' "${test_files[@]}" | awk 'NF && !seen[$0]++')"
[[ -n "$test_files_text" ]] || { echo "test-author Session did not add or modify a test file" >&2; exit 9; }
test_file_count="$(printf '%s\n' "$test_files_text" | awk 'NF { count += 1 } END { print count + 0 }')"
[[ "$test_file_count" -eq 1 ]] || { echo "test-author Session must change exactly one *_test.go file; changed $test_file_count" >&2; exit 10; }
while IFS= read -r file; do
  [[ -f "$sandbox_workspace/$file" ]] || { echo "test-author Session deleted a test file: $file" >&2; exit 10; }
  grep -Eq '^[[:space:]]*func[[:space:]]+TestModel_[A-Za-z0-9_]+' "$sandbox_workspace/$file" || { echo "test file has no TestModel_ function: $file" >&2; exit 10; }
  if [[ -f "$before_workspace/$file" ]]; then
    added_model_declarations="$(diff -u "$before_workspace/$file" "$sandbox_workspace/$file" 2>/dev/null \
      | sed -nE 's/^\+[[:space:]]*func[[:space:]]+(TestModel_[A-Za-z0-9_]+).*/\1/p')"
  else
    added_model_declarations="$(sed -nE 's/^[[:space:]]*func[[:space:]]+(TestModel_[A-Za-z0-9_]+).*/\1/p' "$sandbox_workspace/$file")"
  fi
  added_model_tests="$(printf '%s\n' "$added_model_declarations" | awk 'NF { count += 1 } END { print count + 0 }')"
  [[ "$added_model_tests" -eq 1 ]] || { echo "test-author Session must add exactly one TestModel_ function; added $added_model_tests" >&2; exit 10; }
  added_model_test_name="$(printf '%s\n' "$added_model_declarations" | head -n 1)"
  [[ -n "$added_model_test_name" ]] || { echo "cannot identify the added TestModel_ function" >&2; exit 10; }
  grep -Eq '\[\]struct[[:space:]]*\{' "$sandbox_workspace/$file" || { echo "TestModel_ regression must use table cases" >&2; exit 10; }
  grep -Eq '(^|[^A-Za-z0-9_])t\.Run[[:space:]]*\(' "$sandbox_workspace/$file" || { echo "TestModel_ regression must execute table cases with t.Run" >&2; exit 10; }
done <<<"$test_files_text"

author_bash_commands="$(jq -r '
  select(.type == "assistant")
  | .message.content[]?
  | select(.type == "tool_use" and .name == "Bash")
  | .input.command // empty
' "$raw_stream" 2>/dev/null || true)"
if grep -Eqi 'go[[:space:]]+test[^;&|]*(^|[[:space:]])(\.|\./\.\.\.)([[:space:]]|$)|(^|[[:space:]])-race([[:space:]]|$)|go[[:space:]]+(vet|build)[^;&|]*(^|[[:space:]])(\.|\./\.\.\.)([[:space:]]|$)|(^|[;&|[:space:]])docker[[:space:]]' <<<"$author_bash_commands"; then
  echo "test-author Session executed a prohibited broad, race, build, vet, or Docker command" >&2
  exit 11
fi
focused_command="$(grep -E "go[[:space:]]+test.*${added_model_test_name}" <<<"$author_bash_commands" | head -n 1 || true)"
if [[ -z "$focused_command" || ! "$focused_command" =~ -run || ! "$focused_command" =~ -count=1 ]]; then
  echo "test-author Session must execute the exact $added_model_test_name with -run and -count=1" >&2
  exit 11
fi

test_directory="$(dirname "$test_files_text")"
test_package="."
[[ "$test_directory" == "." ]] || test_package="./$test_directory"
if ! node "$runner_root/scripts/run-with-timeout.mjs" 180 go test "$test_package" -run "^${added_model_test_name}$" -count=1 >&2; then
  echo "independent system replay of $added_model_test_name failed" >&2
  exit 12
fi

author_dir="$task_dir/trajectory/test-author-$session_id"
rm -rf "$author_dir"
mkdir -p "$author_dir"
cp "$native_source" "$author_dir/trajectory.jsonl"
cp "$raw_stream" "$author_dir/raw.stream.jsonl"
cp "$stderr_log" "$author_dir/claude.stderr.log"
printf '%s\n' "$repair_session_id" >"$author_dir/repair_session_id.txt"
test_files_json="$(printf '%s\n' "$test_files_text" | jq -Rsc 'split("\n") | map(select(length > 0))')"
printf '%s\n' "$test_files_json" >"$author_dir/test-files.json"
while IFS= read -r file; do
  mkdir -p "$source_workspace/$(dirname "$file")"
  cp "$sandbox_workspace/$file" "$source_workspace/$file"
done <<<"$test_files_text"
jq -n --arg session_id "$session_id" --arg repair_session_id "$repair_session_id" --argjson test_files "$test_files_json" '{session_id:$session_id,repair_session_id:$repair_session_id,test_files:$test_files}'
