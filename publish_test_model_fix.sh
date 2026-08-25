#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 TASK_DIR FIXED_WORKSPACE SESSION_ID" >&2
  exit 2
fi

task_dir="$(cd "$1" && pwd)"
fixed_workspace="$(cd "$2" && pwd)"
session_id="$3"
meta_file="$task_dir/public.json"

read_meta() {
  jq -r "$1 // empty" "$meta_file"
}

git_flow="$(read_meta '.git_flow')"
workflow_version="$(read_meta '.workflow_version')"
production_flow="$(read_meta '.production_flow')"
repository="$(read_meta '.repository')"
clone_url="$(read_meta '.clone_url')"
main_branch="$(read_meta '.main_branch')"
main_commit="$(read_meta '.main_commit')"
bug_index="$(read_meta '.bug_index')"
bug_main_branch="$(read_meta '.bug_main_branch')"
bug_main_commit="$(read_meta '.bug_main_commit')"
bug_base_branch="$(read_meta '.bug_base_branch')"
bug_base_commit="$(read_meta '.bug_base_commit')"
bug_source="$(read_meta '.bug_source')"
test_branch="$(read_meta '.test_model_fix_branch')"
test_actor="$(read_meta '.test_model_fix_actor')"
test_base="$(read_meta '.test_model_fix_base_commit')"
gold_branch="$(read_meta '.gold_model_fix_branch')"
gold_commit="$(read_meta '.gold_model_fix_commit')"
task_type="$(read_meta '.task_type')"
bug_id="$(read_meta '.bug_id')"
workflow_policy_version="$(read_meta '.workflow_policy_version')"
verification_policy_version="$(read_meta '.verification_policy_version')"
# Workflow policy 4 uses the private-fixture red/green layout. Keep the
# remainder of this script unchanged for historical V1-V3 tasks.
if [[ "${workflow_policy_version:-0}" =~ ^[0-9]+$ && "${verification_policy_version:-0}" =~ ^[0-9]+$ \
  && "$workflow_policy_version" -ge 4 && "$verification_policy_version" -ge 5 ]]; then
  exec "$(cd "$(dirname "$0")" && pwd)/scripts/publish-v4-git-layout.sh" "$task_dir" "$fixed_workspace" "$session_id"
fi
v3_git=false
legacy_v3_git=false
if [[ "${workflow_version:-1}" =~ ^[0-9]+$ ]] && [[ "${workflow_version:-1}" -ge 3 ]]; then
  # Some in-flight V3 tasks were prepared before the orphan green/red Git
  # layout shipped. Their immutable BUG_BASE and pre-fix evidence are already
  # bound to the numbered legacy branches, so migrate the publisher behavior,
  # not their commits. New-layout tasks still fail closed when any required
  # green/red metadata is missing.
  if [[ "$bug_base_branch" =~ ^BUG_BASE[1-9][0-9]*$ ]] \
    && [[ "$production_flow" == "codex_design_claude_generate_then_select_or_inject_bug_before_git_then_claude_fix" ]] \
    && [[ -z "$(read_meta '.green_branch')" ]] \
    && [[ -z "$(read_meta '.red_branch')" ]] \
    && [[ "$test_branch" =~ ^bug-[0-9][0-9]/test_model_fix$|^test_model_fix[1-9][0-9]*$ ]]; then
    legacy_v3_git=true
  else
    v3_git=true
  fi
fi

[[ "$git_flow" == "main_numbered_bug_bases_parallel_model_fixes" ]] || { echo "unsupported git_flow: $git_flow" >&2; exit 3; }
[[ -n "$repository" ]] || { echo "repository is required" >&2; exit 3; }
[[ -n "$clone_url" ]] || clone_url="$repository"
[[ "$bug_index" =~ ^[1-9][0-9]*$ ]] || { echo "bug_index must be a positive integer" >&2; exit 3; }
[[ "$main_branch" == "main" ]] || { echo "main_branch must be main" >&2; exit 3; }
if [[ "$v3_git" != true ]]; then
  [[ "$bug_main_branch" == "bug${bug_index}_main" ]] || { echo "bug_main_branch must be bug${bug_index}_main" >&2; exit 3; }
  [[ "$bug_base_branch" == "BUG_BASE${bug_index}" ]] || { echo "bug_base_branch must be BUG_BASE${bug_index}" >&2; exit 3; }
fi
bug_number="$(printf '%02d' "$bug_index")"
green_branch="$(read_meta '.green_branch')"
red_branch="$(read_meta '.red_branch')"
if [[ "$v3_git" == true ]]; then
  [[ "$green_branch" == "bug${bug_index}_green" ]] || { echo "green_branch must be bug${bug_index}_green" >&2; exit 3; }
  [[ "$bug_base_branch" == "$green_branch" ]] || { echo "V3 bug_base_branch must alias green_branch" >&2; exit 3; }
  [[ "$red_branch" == "bug${bug_index}_red" ]] || { echo "red_branch must be bug${bug_index}_red" >&2; exit 3; }
fi
canonical_test_branch="$green_branch"
if [[ "$v3_git" != true ]]; then
  canonical_test_branch="bug-${bug_number}/test_model_fix"
fi
canonical_gold_branch="bug-${bug_number}/gold_model_fix"
[[ "$test_branch" == "$canonical_test_branch" || ( "$v3_git" != true && "$test_branch" == "test_model_fix${bug_index}" ) ]] || { echo "test_model_fix_branch must be $canonical_test_branch" >&2; exit 3; }
[[ "$test_actor" == "claude_code_cli" ]] || { echo "test_model_fix_actor must be claude_code_cli" >&2; exit 3; }
[[ "$test_base" == "$bug_base_commit" ]] || { echo "test_model_fix must start from BUG_BASE" >&2; exit 3; }
if [[ "${workflow_version:-1}" -lt 3 ]]; then
  [[ "$gold_branch" == "$canonical_gold_branch" || "$gold_branch" == "gold_model_fix${bug_index}" ]] || { echo "gold_model_fix_branch must be $canonical_gold_branch" >&2; exit 3; }
fi

publish_root="$(mktemp -d "${TMPDIR:-/tmp}/go-task-git-publish.XXXXXX")"
publish_cache="${GO_PIPELINE_GIT_PUBLISH_CACHE_DIR:-}"
if [[ -n "$publish_cache" ]]; then
  mkdir -p "$publish_cache"
  delivery_repo="$publish_cache/repository"
else
  delivery_repo="$publish_root/repository"
fi
verification_only_commit=false
allowed_files_tmp="$publish_root/verification-test-files.txt"
: >"$allowed_files_tmp"
cleanup_publish_root() {
  chmod -R u+w "$publish_root" 2>/dev/null || true
  rm -rf "$publish_root" || true
}
trap cleanup_publish_root EXIT

if [[ -d "$delivery_repo/.git" ]]; then
  # A previous publication attempt may have left a valid partial clone. Reset
  # only this disposable cache before refreshing the refs; no model or Docker
  # stage is rerun.
  chmod -R u+w "$delivery_repo" 2>/dev/null || true
  if ! git -C "$delivery_repo" rev-parse --git-dir >/dev/null 2>&1 \
    || ! git -C "$delivery_repo" remote set-url origin "$clone_url" >/dev/null 2>&1; then
    rm -rf "$delivery_repo"
  fi
fi
if [[ ! -d "$delivery_repo/.git" ]]; then
  git clone --quiet --no-checkout --filter=blob:none --no-tags --single-branch \
    --branch "$bug_base_branch" "$clone_url" "$delivery_repo"
else
  git -C "$delivery_repo" fetch --quiet --no-tags --filter=blob:none origin \
    "refs/heads/$bug_base_branch:refs/remotes/origin/$bug_base_branch"
fi
remote_heads="$publish_root/remote-heads.txt"
git -C "$delivery_repo" ls-remote --heads origin >"$remote_heads"

remote_branch_head() {
  local branch="$1"
  awk -v ref="refs/heads/$branch" '$2 == ref { print $1; exit }' "$remote_heads"
}

require_remote_head() {
  local branch="$1"
  local expected="$2"
  local actual
  actual="$(remote_branch_head "$branch")"
  [[ -n "$actual" ]] || { echo "remote branch is missing: $branch" >&2; exit 4; }
  [[ "$actual" == "$expected" ]] || { echo "remote $branch is $actual, expected $expected" >&2; exit 4; }
}

require_remote_head "$main_branch" "$main_commit"
if [[ "$v3_git" == true ]]; then
  green_remote_head="$(remote_branch_head "$green_branch")"
  [[ -n "$green_remote_head" ]] || { echo "remote branch is missing: $green_branch" >&2; exit 4; }
  # A retry may encounter the previous G2 tip. It is safe only when the
  # immutable G1 commit is still its ancestor; the next push replaces the tip
  # with the newly validated G2 commit.
  if [[ "$green_remote_head" != "$bug_base_commit" ]]; then
    git -C "$delivery_repo" merge-base --is-ancestor "$bug_base_commit" "$green_remote_head" \
      || { echo "remote green branch does not descend from G1: $green_remote_head" >&2; exit 4; }
  fi
  green_root_parent_count="$(git -C "$delivery_repo" rev-list --parents -n 1 "$bug_base_commit" | awk '{print NF - 1}')"
  [[ "$green_root_parent_count" == 0 ]] || { echo "green G1 must be an orphan root commit" >&2; exit 4; }
else
  require_remote_head "$bug_main_branch" "$bug_main_commit"
  require_remote_head "$bug_base_branch" "$bug_base_commit"
fi
if [[ "${workflow_version:-1}" -lt 3 ]]; then
  require_remote_head "$gold_branch" "$gold_commit"
  git -C "$delivery_repo" fetch --quiet --no-tags --filter=blob:none origin \
    "refs/heads/$gold_branch:refs/remotes/origin/$gold_branch"
  canonical_gold_head="$(remote_branch_head "$canonical_gold_branch")"
  if [[ -n "$canonical_gold_head" && "$canonical_gold_head" != "$gold_commit" ]]; then
    echo "remote $canonical_gold_branch is $canonical_gold_head, expected $gold_commit" >&2
    exit 4
  fi
  if [[ -z "$canonical_gold_head" ]]; then
    git -C "$delivery_repo" push --quiet origin "$gold_commit:refs/heads/$canonical_gold_branch"
  fi
  gold_parent="$(git -C "$delivery_repo" rev-parse "${gold_commit}^" 2>/dev/null || true)"
fi
if [[ "$v3_git" != true ]]; then
  [[ "$bug_main_commit" == "$main_commit" ]] || { echo "numbered bug_main must point to the generated main commit" >&2; exit 4; }
fi
bug_source="${bug_source:-natural}"
case "$bug_source" in
  natural)
    if [[ "$v3_git" != true ]]; then
      [[ "$bug_base_commit" == "$bug_main_commit" ]] || { echo "natural BUG_BASE must point to bug_main" >&2; exit 4; }
    fi
    ;;
  injected)
    if [[ "$v3_git" != true ]]; then
      [[ "$bug_base_commit" != "$bug_main_commit" ]] || { echo "injected BUG_BASE must differ from bug_main" >&2; exit 4; }
      bug_base_parent="$(git -C "$delivery_repo" rev-parse "${bug_base_commit}^" 2>/dev/null || true)"
      [[ "$bug_base_parent" == "$main_commit" ]] || { echo "injected BUG_BASE must be a direct child of main" >&2; exit 4; }
    fi
    ;;
  *)
    echo "unsupported bug_source: $bug_source" >&2
    exit 4
    ;;
esac
if [[ "${workflow_version:-1}" -lt 3 ]]; then
  [[ "$gold_parent" == "$bug_base_commit" ]] || { echo "gold_model_fix must be a direct child of BUG_BASE" >&2; exit 4; }
fi

# The validated workspace already contains every submitted file. Populate the
# index from BUG_BASE without checking out its blobs, then overlay that exact
# workspace. Large vendored repositories therefore avoid downloading hundreds
# of megabytes merely to overwrite them immediately.
# Reset only the index. Do not check out the remote tree: the validated
# workspace is overlaid below and rsync removes stale cache files.
git -C "$delivery_repo" read-tree --reset "$bug_base_commit"
git -C "$delivery_repo" clean -fdxq
git -C "$delivery_repo" update-ref "refs/heads/$canonical_test_branch" "$bug_base_commit"
git -C "$delivery_repo" symbolic-ref HEAD "refs/heads/$canonical_test_branch"
git -C "$delivery_repo" read-tree "$bug_base_commit"
rsync -a --checksum --delete --exclude='.git/' "$fixed_workspace/" "$delivery_repo/"
git -C "$delivery_repo" add -A

model_verification_plan="$publish_root/model-verification.json"
if [[ "$task_type" == "bugfix" ]]; then
  node "$(cd "$(dirname "$0")" && pwd)/scripts/prepare-model-verification.mjs" \
    "$delivery_repo" "$bug_base_commit" "$task_dir/grader/v4-context.json" >"$model_verification_plan"
  if [[ "$v3_git" == true ]]; then
    jq -r '.verification_test_files[]? // empty' "$model_verification_plan" >"$allowed_files_tmp"
    [[ -s "$allowed_files_tmp" ]] || { echo "V3 bugfix requires repository-owned verification tests for red branch" >&2; exit 5; }
  fi
fi

if [[ "$task_type" == "diagnosis" ]]; then
  diagnosis_verification_plan="$publish_root/diagnosis-verification.json"
  node "$(cd "$(dirname "$0")" && pwd)/scripts/prepare-diagnosis-verification.mjs" \
    "$delivery_repo" "$meta_file" >"$diagnosis_verification_plan"
  jq --slurpfile plan "$diagnosis_verification_plan" \
    '.verification_test_overlay = $plan[0].verification_test_overlay
     | .verification_test_files = $plan[0].verification_test_files
     | .verification_test_names = $plan[0].verification_test_names
     | .verification_test_manifest = $plan[0].verification_test_manifest' \
    "$meta_file" >"${meta_file}.diagnosis-verification"
  mv "${meta_file}.diagnosis-verification" "$meta_file"
  jq -r '.verification_test_files[]? // empty' "$meta_file" >"$allowed_files_tmp"
  [[ -s "$allowed_files_tmp" ]] || { echo "diagnosis repository verification requires verification_test_files" >&2; exit 5; }
  changed_files="$(git -C "$delivery_repo" diff --cached --name-only)
$(git -C "$delivery_repo" diff --name-only)"
  while IFS= read -r changed_file; do
    [[ -z "$changed_file" ]] && continue
    grep -Fxq "$changed_file" "$allowed_files_tmp" || {
      echo "diagnosis workspace contains a non-verification change: $changed_file" >&2
      exit 5
    }
  done <<<"$changed_files"
  if git -C "$delivery_repo" diff --cached --quiet; then
    test_commit="$bug_base_commit"
    verification_only_commit=false
  else
    git -C "$delivery_repo" -c user.name='Claude Test Model' -c user.email='claude-test-model@local.invalid' \
      commit --quiet -m "test: add public verification for $bug_id"
    test_commit="$(git -C "$delivery_repo" rev-parse HEAD)"
    verification_only_commit=true
  fi
else
  if git -C "$delivery_repo" diff --cached --quiet; then
    echo "bugfix workspace has no changes relative to BUG_BASE" >&2
    exit 5
  fi
  git -C "$delivery_repo" -c user.name='Claude Test Model' -c user.email='claude-test-model@local.invalid' \
    commit --quiet -m "fix: $bug_id (Claude test model)"
  test_commit="$(git -C "$delivery_repo" rev-parse HEAD)"
fi

canonical_test_head="$(remote_branch_head "$canonical_test_branch")"
git -C "$delivery_repo" push --quiet \
  "--force-with-lease=refs/heads/$canonical_test_branch:$canonical_test_head" \
  origin "$test_commit:refs/heads/$canonical_test_branch"

red_commit=""
if [[ "$v3_git" == true ]] && [[ "$task_type" == "bugfix" || "$task_type" == "diagnosis" ]]; then
  # Build R1 from the exact G1 tree as an orphan root, then overlay only the
  # repository-owned acceptance tests. The red/green trees therefore differ by
  # test files and share no Git parent, matching the delivery guide.
  git -C "$delivery_repo" switch --orphan "$red_branch" >/dev/null
  git -C "$delivery_repo" read-tree "$bug_base_commit"
  git -C "$delivery_repo" clean -fdxq
  git -C "$delivery_repo" checkout-index -a
  while IFS= read -r verification_file; do
    [[ -n "$verification_file" ]] || continue
    [[ "$verification_file" != /* && "$verification_file" != *..* ]] || { echo "unsafe verification file: $verification_file" >&2; exit 5; }
    [[ "$verification_file" == *_test.go ]] || { echo "red branch may contain only *_test.go overlays" >&2; exit 5; }
    [[ -f "$fixed_workspace/$verification_file" ]] || { echo "verification file missing from fixed workspace: $verification_file" >&2; exit 5; }
    mkdir -p "$delivery_repo/$(dirname "$verification_file")"
    cp "$fixed_workspace/$verification_file" "$delivery_repo/$verification_file"
  done <"$allowed_files_tmp"
  git -C "$delivery_repo" add -A
  changed_red_files="$(git -C "$delivery_repo" diff --cached --name-only "$bug_base_commit")"
  while IFS= read -r changed_red_file; do
    [[ -z "$changed_red_file" ]] && continue
    grep -Fxq "$changed_red_file" "$allowed_files_tmp" || {
      echo "red branch contains a non-verification change: $changed_red_file" >&2
      exit 5
    }
  done <<<"$changed_red_files"
  git -C "$delivery_repo" -c user.name='Go Pipeline' -c user.email='go-pipeline@local.invalid' \
    commit --quiet -m 'test: acceptance checks'
  red_commit="$(git -C "$delivery_repo" rev-parse HEAD)"
  red_parent_count="$(git -C "$delivery_repo" rev-list --parents -n 1 "$red_commit" | awk '{print NF - 1}')"
  [[ "$red_parent_count" == 0 ]] || { echo "red R1 must be an orphan root commit" >&2; exit 5; }
  red_remote_head="$(remote_branch_head "$red_branch")"
  git -C "$delivery_repo" push --quiet \
    "--force-with-lease=refs/heads/$red_branch:$red_remote_head" \
    origin "$red_commit:refs/heads/$red_branch"
  git -C "$delivery_repo" switch "$canonical_test_branch" >/dev/null
  git -C "$delivery_repo" read-tree "$test_commit"
  git -C "$delivery_repo" checkout-index -a -f
  test_parent="$(git -C "$delivery_repo" rev-parse "${test_commit}^" 2>/dev/null || true)"
  [[ "$test_parent" == "$bug_base_commit" ]] || { echo "green G2 must be a direct child of green G1" >&2; exit 5; }
  for verification_file in $(cat "$allowed_files_tmp"); do
    green_blob="$(git -C "$delivery_repo" rev-parse "$test_commit:$verification_file" 2>/dev/null || true)"
    red_blob="$(git -C "$delivery_repo" rev-parse "$red_commit:$verification_file" 2>/dev/null || true)"
    [[ -n "$green_blob" && "$green_blob" == "$red_blob" ]] || { echo "red/green verification file mismatch: $verification_file" >&2; exit 5; }
  done
fi

repository_web="${repository%.git}"
repository_web="${repository_web%/}"
branch_url="$repository_web/tree/$canonical_test_branch"
updated_meta="$publish_root/public.json"
verification_files_json="$(jq -Rsc 'split("\n") | map(select(length > 0))' "$allowed_files_tmp")"
jq \
  --arg commit "$test_commit" \
  --arg url "$branch_url" \
  --arg session "$session_id" \
  --arg test_branch "$canonical_test_branch" \
  --arg main_commit "$main_commit" \
  --arg green_branch "$green_branch" \
  --arg green_baseline_commit "$bug_base_commit" \
  --arg red_branch "$red_branch" \
  --arg red_commit "$red_commit" \
  --argjson verification_only "$verification_only_commit" \
  --argjson verification_files "$verification_files_json" \
  '.test_model_fix_commit = $commit
   | .test_model_fix_pushed = true
   | .test_model_fix_session_id = $session
   | .test_model_fix_branch = $test_branch
   | .repo_url = $url
   | if $green_branch != "" then .green_branch = $green_branch | .green_baseline_commit = $green_baseline_commit | .green_fix_commit = $commit | .model_input_branch = $green_branch | .model_input_commit = $green_baseline_commit | .model_input_snapshot = "single-branch-single-commit-no-tests" else . end
   | if $red_commit != "" then .red_branch = $red_branch | .red_commit = $red_commit | .red_pushed = true | .red_test_files = $verification_files else . end
   | if $verification_only then .verification_test_only_commit = true | .verification_test_only_files = $verification_files | .bug_base_parent_commit = $main_commit else . end' \
  "$meta_file" >"$updated_meta"
if [[ "${workflow_version:-1}" -lt 3 ]]; then
  jq --arg gold_branch "$canonical_gold_branch" '.gold_model_fix_branch = $gold_branch' \
    "$updated_meta" >"${updated_meta}.gold"
  mv "${updated_meta}.gold" "$updated_meta"
fi
if [[ "$task_type" == "bugfix" ]]; then
  jq --slurpfile plan "$model_verification_plan" \
    '. as $base | $plan[0] as $model
     | $base
     | .verify_cmds = $model.verify_cmds
     | .verification_test_overlay = $model.verification_test_overlay
     | .verification_test_files = $model.verification_test_files
     | .verification_test_names = $model.verification_test_names
     | .verification_test_manifest = $model.verification_test_manifest
     | .model_verification_policy_version = $model.policy_version
     | if (($base.verification_policy_version // 0) >= 5)
       then .verification_evidence = {} | .verify_result = "" | del(.verification_coverage)
       else .
       end' "$updated_meta" >"${updated_meta}.model"
  mv "${updated_meta}.model" "$updated_meta"
fi
mv "$updated_meta" "$meta_file"

printf '%s\n' "$test_commit"
