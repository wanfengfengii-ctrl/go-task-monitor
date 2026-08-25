#!/usr/bin/env bash
set -uo pipefail

phase="${1:?phase is required}"
shift
results="verification-command-results.jsonl"
: >"$results"
mapfile_supported=0
if type mapfile >/dev/null 2>&1; then mapfile_supported=1; fi
expected_commands=()
if [[ "$mapfile_supported" -eq 1 ]]; then
  mapfile -t expected_commands <verify-commands.txt
else
  while IFS= read -r command || [[ -n "$command" ]]; do expected_commands+=("$command"); done <verify-commands.txt
fi
provided_commands=("$@")
if [[ "${#provided_commands[@]}" -ne "${#expected_commands[@]}" ]]; then
  echo "verify_cmds argument count does not match the immutable command list" >&2
  exit 23
fi
for ((provided_index = 0; provided_index < ${#expected_commands[@]}; provided_index += 1)); do
  if [[ "${provided_commands[$provided_index]}" != "${expected_commands[$provided_index]}" ]]; then
    echo "verify_cmds argument $((provided_index + 1)) does not match the immutable command list" >&2
    exit 23
  fi
done
source_commit="$(jq -r --arg phase "$phase" 'if $phase == "pre_fix" then .bug_base_commit else .test_model_fix_commit end // empty' public.json)"
verify_cmds_sha256="$(jq -c '.verify_cmds' public.json | shasum -a 256 | awk '{print $1}')"
printf 'VERIFY_PROOF phase=%s source_commit=%s verify_cmds_sha256=%s\n' "$phase" "$source_commit" "$verify_cmds_sha256"
target_total=0
target_failed=0
infra_failed=0
verification_failed=0
index=0
for command in "${provided_commands[@]}"; do
  [[ -n "$command" ]] || continue
  index=$((index + 1))
  kind="verification"
  if [[ "$command" == docker\ build* ]]; then
    kind="infrastructure"
  elif [[ "$command" == *"/grader/run_target.sh"* ]]; then
    kind="target"
    target_total=$((target_total + 1))
  elif [[ "$command" == docker\ image\ rm* ]]; then
    kind="cleanup"
  fi
  printf '\n$ %s\n' "$command"
  bash -lc "$command"
  exit_code=$?
  jq -cn --argjson index "$index" --arg command "$command" --arg kind "$kind" --argjson exit_code "$exit_code" \
    '{index:$index,command:$command,kind:$kind,exit_code:$exit_code}' >>"$results"
  if [[ "$kind" == "infrastructure" && "$exit_code" -ne 0 ]]; then infra_failed=$((infra_failed + 1)); fi
  if [[ "$kind" == "target" && "$exit_code" -ne 0 ]]; then target_failed=$((target_failed + 1)); fi
  if [[ "$kind" == "verification" && "$exit_code" -ne 0 ]]; then verification_failed=$((verification_failed + 1)); fi
done

result="invalid"
exit_code=22
if [[ "$infra_failed" -gt 0 || "$target_total" -eq 0 ]]; then
  result="infrastructure_error"
  exit_code=20
elif [[ "$phase" == "pre_fix" && "$target_failed" -eq "$target_total" ]]; then
  result="red"
  exit_code=1
elif [[ "$phase" == "post_fix" && "$target_failed" -eq 0 && "$verification_failed" -eq 0 ]]; then
  result="green"
  exit_code=0
fi
jq -n --arg phase "$phase" --arg result "$result" --argjson exit_code "$exit_code" \
  --argjson target_total "$target_total" --argjson target_failed "$target_failed" \
  --argjson infrastructure_failed "$infra_failed" --argjson verification_failed "$verification_failed" \
  '{phase:$phase,result:$result,exit_code:$exit_code,target_total:$target_total,target_failed:$target_failed,infrastructure_failed:$infrastructure_failed,verification_failed:$verification_failed}' \
  >verification-result.json
printf 'VERIFY_RESULT phase=%s result=%s exit_code=%s\n' "$phase" "$result" "$exit_code"
# The structured result preserves red/green and every command exit code. Keep the
# outer tool call successful so Claude does not retry an expected pre-fix red run.
exit 0
