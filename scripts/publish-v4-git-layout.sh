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
read_meta() { jq -r "$1 // empty" "$meta_file"; }

task_type="$(read_meta '.task_type')"
repository="$(read_meta '.repository')"
clone_url="$(read_meta '.clone_url')"
main_branch="$(read_meta '.main_branch')"
main_commit="$(read_meta '.main_commit')"
bug_index="$(read_meta '.bug_index')"
bug_base_commit="$(read_meta '.bug_base_commit')"
bug_base_branch="$(read_meta '.bug_base_branch')"
green_branch="$(read_meta '.green_branch')"
red_branch="$(read_meta '.red_branch')"
test_branch="$(read_meta '.test_model_fix_branch')"
fixture_dir="$(read_meta '.verification_fixture_dir')"
fixture_file="$(read_meta '.verification_test_files[0]')"
fixture_sha="$(read_meta '.verification_fixture_sha256')"
verification_overlay="$(read_meta '.verification_test_overlay')"
layout_meta="$task_dir/.git-layout.json"
prepared_repo=""
prepared_green_commit=""
prepared_red_commit=""
if [[ -s "$layout_meta" ]]; then
  prepared_repo="$(jq -r '.repository // empty' "$layout_meta")"
  prepared_green_commit="$(jq -r '.green_commit // empty' "$layout_meta")"
  prepared_red_commit="$(jq -r '.red_commit // empty' "$layout_meta")"
fi

[[ "$task_type" == "bugfix" || "$task_type" == "diagnosis" ]] || { echo "unsupported task_type: $task_type" >&2; exit 3; }
[[ -n "$repository" && -n "$clone_url" ]] || { echo "repository and clone_url are required" >&2; exit 3; }
[[ "$main_branch" == "main" && "$main_commit" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "invalid frozen main metadata" >&2; exit 3; }
[[ "$bug_index" =~ ^[1-9][0-9]*$ ]] || { echo "bug_index must be positive" >&2; exit 3; }
[[ "$red_branch" == "bug${bug_index}_red" ]] || { echo "red_branch must be bug${bug_index}_red" >&2; exit 3; }
if [[ "$task_type" == "bugfix" ]]; then
  [[ "$green_branch" == "bug${bug_index}_green" ]] || { echo "green_branch must be bug${bug_index}_green" >&2; exit 3; }
  [[ "$test_branch" == "$green_branch" ]] || { echo "bugfix test_model_fix_branch must be green_branch" >&2; exit 3; }
  [[ "$bug_base_branch" == "$green_branch" && "$bug_base_commit" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "bugfix G1 metadata is incomplete" >&2; exit 3; }
else
  [[ "$test_branch" == "$red_branch" ]] || { echo "diagnosis test_model_fix_branch must be red_branch" >&2; exit 3; }
fi

if [[ "$task_type" == "bugfix" || -n "$fixture_file" ]]; then
  [[ -n "$fixture_file" ]] || { echo "verification_test_files must contain a safe *_test.go" >&2; exit 3; }
  while IFS= read -r verification_file; do
    [[ -n "$verification_file" ]] || continue
    [[ "$verification_file" != /* && "$verification_file" != *..* && "$verification_file" == *_test.go ]] \
      || { echo "verification_test_files must contain only safe *_test.go paths" >&2; exit 3; }
  done < <(jq -r '.verification_test_files[]? // empty' "$meta_file")
fi
if [[ -n "$fixture_dir" ]]; then
  fixture_dir="$(cd "$fixture_dir" && pwd)"
  task_root="$task_dir"
  [[ "$fixture_dir" == "$task_root" || "$fixture_dir" == "$task_root"/* ]] || { echo "fixture directory escapes task" >&2; exit 3; }
  [[ -f "$fixture_dir/$fixture_file" ]] || { echo "private verification fixture is missing" >&2; exit 3; }
  if [[ -n "$fixture_sha" ]]; then
    actual_fixture_sha="$(shasum -a 256 "$fixture_dir/$fixture_file" | awk '{print $1}')"
    [[ "$actual_fixture_sha" == "$fixture_sha" ]] || { echo "private verification fixture hash mismatch" >&2; exit 3; }
  fi
fi
if [[ "$task_type" == "bugfix" ]]; then
  [[ "$verification_overlay" == "repository-tests" || "$verification_overlay" == "private-fixture" ]] \
    || { echo "bugfix verification tests must be repository-tests" >&2; exit 3; }
  if [[ "$verification_overlay" == "repository-tests" ]]; then
    [[ -n "$fixture_file" && -f "$fixed_workspace/$fixture_file" ]] || { echo "Codex acceptance test is missing from fixed workspace" >&2; exit 3; }
    actual_fixture_sha="$(shasum -a 256 "$fixed_workspace/$fixture_file" | awk '{print $1}')"
    if [[ -n "$fixture_sha" ]]; then
      [[ "$actual_fixture_sha" == "$fixture_sha" ]] || { echo "Codex acceptance test hash mismatch" >&2; exit 3; }
    else
      fixture_sha="$actual_fixture_sha"
    fi
  fi
fi

publish_root="$(mktemp -d "${TMPDIR:-/tmp}/go-task-git-v4.XXXXXX")"
cache_root="${GO_PIPELINE_GIT_PUBLISH_CACHE_DIR:-$publish_root/cache}"
delivery_repo="$cache_root/repository"
mkdir -p "$cache_root"
cleanup() { chmod -R u+w "$publish_root" "$delivery_repo" 2>/dev/null || true; rm -rf "$publish_root"; }
trap cleanup EXIT

if [[ -d "$delivery_repo/.git" ]]; then
  git -C "$delivery_repo" remote set-url origin "$clone_url" >/dev/null 2>&1 || { rm -rf "$delivery_repo"; }
fi
if [[ ! -d "$delivery_repo/.git" ]]; then
  git clone --quiet --no-checkout --filter=blob:none --no-tags --single-branch --branch main "$clone_url" "$delivery_repo"
else
  git -C "$delivery_repo" fetch --quiet --no-tags --filter=blob:none origin \
    "refs/heads/main:refs/remotes/origin/main"
fi

remote_heads="$publish_root/remote-heads.txt"
git -C "$delivery_repo" ls-remote --heads origin >"$remote_heads"
remote_head() { awk -v ref="refs/heads/$1" '$2 == ref { print $1; exit }' "$remote_heads"; }
require_remote() {
  actual="$(remote_head "$1")"
  [[ "$actual" == "$2" ]] || { echo "remote $1 is ${actual:-missing}, expected $2" >&2; exit 4; }
}
require_remote main "$main_commit"

checkout_tree() {
  local commit="$1"
  chmod -R u+rwX "$delivery_repo" 2>/dev/null || true
  git -C "$delivery_repo" reset --hard "$commit" >/dev/null
  git -C "$delivery_repo" read-tree --reset "$commit"
  git -C "$delivery_repo" clean -fdxq
  git -C "$delivery_repo" checkout-index -a -f
}
overlay_fixture() {
  if [[ -z "$fixture_dir" && "$task_type" == "bugfix" ]]; then
    mkdir -p "$delivery_repo/$(dirname "$fixture_file")"
    cp "$fixed_workspace/$fixture_file" "$delivery_repo/$fixture_file"
    return 0
  fi
  [[ -n "$fixture_dir" ]] || return 0
  mkdir -p "$delivery_repo/$(dirname "$fixture_file")"
  cp "$fixture_dir/$fixture_file" "$delivery_repo/$fixture_file"
}
assert_allowed_test_changes() {
  local base_commit="${1:-}"
  local changed_file
  local changed_files
  if [[ -n "$base_commit" ]]; then
    changed_files=("$(git -C "$delivery_repo" diff --cached --name-only "$base_commit" --)")
  else
    changed_files=("$(git -C "$delivery_repo" diff --cached --name-only)")
  fi
  while IFS= read -r changed_file; do
    [[ -n "$changed_file" && "$changed_file" == *_test.go ]] || continue
    if ! jq -e --arg filename "$changed_file" '.verification_test_files // [] | index($filename)' "$meta_file" >/dev/null; then
      echo "Claude workspace contains an unapproved test change: $changed_file" >&2
      echo "only the frozen verification_test_files may be added or changed during Git publication" >&2
      exit 5
    fi
  done <<< "${changed_files[0]}"
}
commit_root() {
  local branch="$1" message="$2"
  local tree_commit="${3:-}"
  local source_workspace="${4:-}"
  chmod -R u+rwX "$delivery_repo" 2>/dev/null || true
  git -C "$delivery_repo" branch -D "$branch" >/dev/null 2>&1 || true
  git -C "$delivery_repo" switch --orphan "$branch" >/dev/null
  if [[ -n "$tree_commit" ]]; then
    # `git switch --orphan` clears tracked files from the worktree. Rehydrate
    # the original environment before adding the shared verification fixture.
    git -C "$delivery_repo" read-tree "$tree_commit"
    git -C "$delivery_repo" checkout-index -a -f
  fi
  if [[ -n "$source_workspace" ]]; then
    rsync -a --checksum --delete --exclude='.git/' "$source_workspace/" "$delivery_repo/"
  fi
  overlay_fixture
  git -C "$delivery_repo" add -A
  assert_allowed_test_changes "$tree_commit"
  git -C "$delivery_repo" -c user.name='Go Pipeline' -c user.email='go-pipeline@local.invalid' commit --quiet --allow-empty -m "$message"
  git -C "$delivery_repo" rev-parse HEAD
}
push_branch() {
  local branch="$1" commit="$2"
  local expected="$(remote_head "$branch")"
  git -C "$delivery_repo" push --quiet \
    "--force-with-lease=refs/heads/$branch:${expected}" \
    origin "$commit:refs/heads/$branch"
}

if [[ "$task_type" == "bugfix" ]]; then
  green_remote_head="$(remote_head "$green_branch")"
  [[ -n "$green_remote_head" ]] || { echo "remote $green_branch is missing" >&2; exit 4; }
  git -C "$delivery_repo" fetch --quiet --no-tags origin "refs/heads/$green_branch:refs/remotes/origin/$green_branch"
  if [[ "$green_remote_head" != "$bug_base_commit" ]]; then
    git -C "$delivery_repo" merge-base --is-ancestor "$bug_base_commit" "$green_remote_head" \
      || { echo "remote green branch does not descend from G1" >&2; exit 4; }
  fi
  green_parent_count="$(git -C "$delivery_repo" rev-list --parents -n 1 "$bug_base_commit" | awk '{print NF - 1}')"
  [[ "$green_parent_count" == 0 ]] || { echo "green G1 must be an orphan root" >&2; exit 4; }
  if [[ -n "$prepared_repo" && "$prepared_green_commit" =~ ^[0-9a-fA-F]{40}$ && "$prepared_red_commit" =~ ^[0-9a-fA-F]{40}$ ]]; then
    [[ "$prepared_repo" == "$task_dir"/* && -d "$prepared_repo/.git" ]] || { echo "prepared Git layout escapes task directory" >&2; exit 5; }
    git -C "$delivery_repo" fetch --quiet --no-tags "$prepared_repo" \
      "refs/heads/$green_branch:refs/remotes/prepared/$green_branch" \
      "refs/heads/$red_branch:refs/remotes/prepared/$red_branch"
    green_commit="$prepared_green_commit"
  else
    git -C "$delivery_repo" switch -C "$green_branch" "$bug_base_commit" >/dev/null
    checkout_tree "$bug_base_commit"
    rsync -a --checksum --delete --exclude='.git/' "$fixed_workspace/" "$delivery_repo/"
    overlay_fixture
    git -C "$delivery_repo" add -A
    assert_allowed_test_changes "$bug_base_commit"
    git -C "$delivery_repo" diff --cached --quiet && { echo "bugfix workspace has no changes relative to G1" >&2; exit 5; }
    git -C "$delivery_repo" -c user.name='Claude Code' -c user.email='claude-code@local.invalid' commit --quiet -m "fix: $(read_meta '.bug_id')"
    green_commit="$(git -C "$delivery_repo" rev-parse HEAD)"
  fi
  green_parent="$(git -C "$delivery_repo" rev-parse "${green_commit}^")"
  [[ "$green_parent" == "$bug_base_commit" ]] || { echo "green G2 must directly descend from G1" >&2; exit 5; }
  green_test_sha="$(git -C "$delivery_repo" show "$green_commit:$fixture_file" | shasum -a 256 | awk '{print $1}')"
  [[ "$green_test_sha" == "$fixture_sha" ]] || { echo "green G2 acceptance test hash does not match Codex test" >&2; exit 5; }
  push_branch "$green_branch" "$green_commit"

  if [[ -n "$prepared_repo" && "$prepared_red_commit" =~ ^[0-9a-fA-F]{40}$ ]]; then
    red_commit="$prepared_red_commit"
  else
    checkout_tree "$bug_base_commit"
    red_commit="$(commit_root "$red_branch" 'test: acceptance checks' "$bug_base_commit")"
  fi
  [[ "$(git -C "$delivery_repo" rev-list --parents -n 1 "$red_commit" | awk '{print NF - 1}')" == 0 ]] || { echo "red R1 must be orphan" >&2; exit 5; }
  red_test_sha="$(git -C "$delivery_repo" show "$red_commit:$fixture_file" | shasum -a 256 | awk '{print $1}')"
  [[ "$red_test_sha" == "$fixture_sha" && "$red_test_sha" == "$green_test_sha" ]] || { echo "red R1 and green G2 acceptance tests are not byte-identical" >&2; exit 5; }
  push_branch "$red_branch" "$red_commit"
  delivery_commit="$green_commit"
  delivery_branch="$green_branch"
else
  # The read-only Diagnosis Session must return the exact frozen source tree.
  # After that Session ends, the trusted system publisher creates a new orphan
  # R1 containing the byte-identical source plus the independently authored
  # acceptance test. The model workspace itself remains untouched.
  red_commit="$(remote_head "$red_branch")"
  [[ -n "$red_commit" && "$red_commit" == "$bug_base_commit" ]] \
    || { echo "remote diagnosis red branch is ${red_commit:-missing}, expected $bug_base_commit" >&2; exit 4; }
  git -C "$delivery_repo" fetch --quiet --no-tags origin "refs/heads/$red_branch:refs/remotes/origin/$red_branch"
  [[ "$(git -C "$delivery_repo" rev-list --parents -n 1 "$red_commit" | awk '{print NF - 1}')" == 0 ]] \
    || { echo "diagnosis red R1 must be orphan" >&2; exit 5; }
  if git -C "$delivery_repo" cat-file -e "$red_commit:$fixture_file" 2>/dev/null; then
    red_test_sha="$(git -C "$delivery_repo" show "$red_commit:$fixture_file" | shasum -a 256 | awk '{print $1}')"
    if [[ -n "$fixture_sha" ]]; then
      [[ "$red_test_sha" == "$fixture_sha" ]] || { echo "published diagnosis test hash does not match the system fixture" >&2; exit 5; }
    else
      fixture_sha="$red_test_sha"
    fi
  else
    checkout_tree "$red_commit"
    rsync -a --checksum --delete --exclude='.git/' "$fixed_workspace/" "$delivery_repo/"
    git -C "$delivery_repo" add -A
    git -C "$delivery_repo" diff --cached --quiet \
      || { echo "diagnosis workspace differs from the frozen red R1" >&2; exit 5; }
    # The diagnosis workspace is intentionally read-only. Its file modes must
    # not make the trusted temporary publication repository read-only too.
    chmod -R u+rwX "$delivery_repo" 2>/dev/null || true
    red_commit="$(commit_root "$red_branch" 'test: public diagnosis acceptance' "$bug_base_commit")"
    [[ "$(git -C "$delivery_repo" rev-list --parents -n 1 "$red_commit" | awk '{print NF - 1}')" == 0 ]] \
      || { echo "published diagnosis red R1 must be orphan" >&2; exit 5; }
    red_test_sha="$(git -C "$delivery_repo" show "$red_commit:$fixture_file" | shasum -a 256 | awk '{print $1}')"
    [[ "$red_test_sha" == "$fixture_sha" ]] || { echo "diagnosis R1 acceptance test hash does not match the system fixture" >&2; exit 5; }
    push_branch "$red_branch" "$red_commit"
  fi
  delivery_commit="$red_commit"
  delivery_branch="$red_branch"
  green_commit=""
fi

repository_web="${repository%.git}"
repository_web="${repository_web%/}"
updated_meta="$publish_root/public.json"
jq \
  --arg commit "$delivery_commit" \
  --arg url "$repository_web/tree/$delivery_branch" \
  --arg branch "$delivery_branch" \
  --arg session "$session_id" \
  --arg red_commit "$red_commit" \
  --arg green_commit "${green_commit:-}" \
  --arg fixture_sha "$fixture_sha" \
  '.test_model_fix_commit = $commit
   | .test_model_fix_pushed = true
   | .test_model_fix_branch = $branch
   | .test_model_fix_session_id = $session
   | .repo_url = $url
   | .red_branch = .red_branch
   | .red_commit = $red_commit
   | .red_pushed = true
   | .red_test_files = (if .verification_test_files then .verification_test_files else [] end)
   | if $green_commit != "" then .green_fix_commit = $green_commit else .green_branch = "" | .green_fix_commit = "" | .green_baseline_commit = "" | .green_baseline_pushed = false | .bug_base_branch = "" | .bug_base_commit = $red_commit | .bug_base_pushed = false | .test_model_fix_base_commit = $red_commit | .model_input_branch = "" | .model_input_commit = "" | .model_input_snapshot = "single-branch-single-commit-no-tests" end
   | .verification_fixture_published = true
   | .verification_fixture_materialized = false
   | .verification_test_published = true
   | .verification_test_overlay = "repository-tests"
   | .verification_test_storage = "repository-red-branch"
   | .verification_test_sha256 = $fixture_sha' \
  "$meta_file" >"$updated_meta"
mv "$updated_meta" "$meta_file"
printf '%s\n' "$delivery_commit"
