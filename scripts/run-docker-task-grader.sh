#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 2 ]]; then
  grader_dir="$(cd "$(dirname "$0")" && pwd)"
  task_dir="$(cd "$grader_dir/.." && pwd)"
  workspace="$(cd "$1" && pwd)"
  task_type="$2"
elif [[ $# -eq 3 ]]; then
  task_dir="$(cd "$1" && pwd)"
  workspace="$(cd "$2" && pwd)"
  task_type="$3"
  grader_dir="$task_dir/grader"
else
  echo "usage: $0 [TASK_DIR] WORKSPACE TASK_TYPE" >&2
  exit 2
fi
platforms=(linux/arm64 linux/amd64)
docker_config_dir="$(mktemp -d "${TMPDIR:-/tmp}/go-task-docker-config.XXXXXX")"

# The Dockerfile is task-owned and normally copies the source tree only to
# seed the dependency/build layers. Runtime commands always use the read-only
# /workspace mount below. Keep the reusable image keyed by the toolchain and
# module graph so a later source change cannot accidentally reuse a different
# dependency environment.
go_version="${GO_PIPELINE_GO_TOOLCHAIN_VERSION:-}"
if [[ -z "$go_version" && -f "$workspace/benzhi.Dockerfile" ]]; then
  # Use awk instead of sed -E: macOS BSD sed rejects the GNU-only
  # non-capturing group (?:...), which previously masked the real grader
  # result as exit=7.
  go_version="$(awk '
    toupper($1) == "FROM" {
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^golang:[0-9]/) {
          value = $i
          sub(/^golang:/, "", value)
          sub(/@.*/, "", value)
          sub(/[^0-9.].*/, "", value)
          print value
          exit
        }
      }
    }
  ' "$workspace/benzhi.Dockerfile")"
fi
if [[ -z "$go_version" && -f "$workspace/go.mod" ]]; then
  go_version="$(awk '$1 == "go" { print $2; exit }' "$workspace/go.mod")"
fi
if [[ ! "$go_version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "cannot determine a valid Go toolchain version from benzhi.Dockerfile or go.mod: ${go_version:-<empty>}" >&2
  echo "FAILURE_CLASS=docker_configuration" >&2
  exit 90
fi
module_fingerprint="$( {
  [[ -f "$workspace/go.mod" ]] && cat "$workspace/go.mod"
  [[ -f "$workspace/go.sum" ]] && cat "$workspace/go.sum"
  [[ -f "$workspace/benzhi.Dockerfile" ]] && cat "$workspace/benzhi.Dockerfile"
} | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
module_fingerprint="${module_fingerprint:-no-modules}"
workspace_fingerprint="$(
  cd "$workspace"
  find . -type f ! -path './.git/*' ! -path '*/node_modules/*' -exec shasum -a 256 {} \; \
    | LC_ALL=C sort \
    | shasum -a 256 \
    | awk '{print substr($1, 1, 16)}'
)"
module_fingerprint="$(printf '%s|%s\n' "$module_fingerprint" "${workspace_fingerprint:-no-source}" \
  | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
image_stem="go-task-grader-go${go_version}-${module_fingerprint}"
lock_root="${GO_PIPELINE_DOCKER_LOCK_ROOT:-$(cd "$task_dir/../../.." && pwd)/docker-cache/locks}"
mkdir -p "$lock_root"
refresh_images="${REFRESH_GRADER_IMAGES:-0}"
docker_run_cpu_limit="${GO_PIPELINE_DOCKER_RUN_CPUS:-2}"
startup_probe_seconds="${GO_PIPELINE_CONTAINER_STARTUP_PROBE_SECONDS:-3}"
active_probe_container=""

# The task images are public and do not need a registry credential.  Docker
# Desktop's credential helper can hang while resolving an otherwise public
# image, leaving the grader pipe open indefinitely.  Give this invocation a
# minimal config so an unavailable desktop helper cannot block verification.
printf '%s\n' '{"auths":{},"cliPluginsExtraDirs":["/Applications/Docker.app/Contents/Resources/cli-plugins"]}' \
  >"$docker_config_dir/config.json"
export DOCKER_CONFIG="$docker_config_dir"
# Buildx keeps named builder definitions beneath the normal Docker config.
# Reuse only that non-secret metadata while registry auth stays isolated.
export BUILDX_CONFIG="${BUILDX_CONFIG:-$HOME/.docker/buildx}"

cleanup() {
  if [[ -n "$active_probe_container" ]]; then
    docker rm -f "$active_probe_container" >/dev/null 2>&1 || true
  fi
  rm -rf "$docker_config_dir"
}
trap cleanup EXIT

if [[ "$task_type" != "bugfix" && "$task_type" != "diagnosis" ]]; then
  echo "unsupported task type: $task_type" >&2
  exit 2
fi
for required in run_target.sh run_full.sh run_static.sh; do
  [[ -x "$grader_dir/$required" ]] || { echo "missing grader script: $required" >&2; exit 2; }
done
compile_script="run_compile.sh"
[[ -x "$grader_dir/$compile_script" ]] || compile_script="run_full.sh"
docker version >/dev/null
# Keep benchmark builds off Docker Desktop's default builder. The dedicated
# builder has the same supported platforms but avoids frontend metadata locks
# shared with unrelated interactive builds; callers can override it explicitly.
export BUILDX_BUILDER="${BUILDX_BUILDER:-benzhi-builder}"

acquire_cache_lock() {
  local lock_dir="$1"
  local waited=0
  local max_wait="${GRADER_CACHE_LOCK_WAIT_SECONDS:-1800}"
  while ! mkdir "$lock_dir" 2>/dev/null; do
    local owner=""
    if [[ -f "$lock_dir/pid" ]]; then owner="$(<"$lock_dir/pid")"; fi
    if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$lock_dir"
      continue
    fi
    if (( waited >= max_wait )); then
      echo "timed out waiting for grader cache lock: $lock_dir" >&2
      return 1
    fi
    sleep 1
    ((waited += 1))
  done
  printf '%s\n' "$$" >"$lock_dir/pid"
}

release_cache_lock() {
  rm -rf "$1"
}

build_image() {
  local image_reference="$1"
  local platform="$2"
  local platform_tag="${platform#linux/}"
  local cache_lock="$lock_root/$image_stem-$platform_tag.lock"
  cached_matches() {
    local labels
    labels="$(docker image inspect --format '{{ index .Config.Labels "go-task-grader.go_version" }}|{{ index .Config.Labels "go-task-grader.module_sha" }}' "$image_reference" 2>/dev/null || true)"
    [[ "$labels" == "$go_version|$module_fingerprint" ]]
  }
  acquire_cache_lock "$cache_lock" || return $?
  if [[ "$refresh_images" != "1" ]] && docker image inspect "$image_reference" >/dev/null 2>&1 && cached_matches; then
    release_cache_lock "$cache_lock"
    echo "Reusing cached grader image $image_reference ($platform)"
    return 0
  fi
  # Invoke Buildx explicitly. A plain `docker build` silently uses the
  # Desktop default builder and makes BUILDX_BUILDER ineffective, which can
  # strand the whole compute-heavy pool on a stale frontend lease.
  local build_status=0
  docker buildx build --builder "$BUILDX_BUILDER" --load \
    --platform "$platform" -f "$workspace/benzhi.Dockerfile" \
    --label "go-task-grader.go_version=$go_version" \
    --label "go-task-grader.module_sha=$module_fingerprint" \
    -t "$image_reference" "$workspace" || build_status=$?
  release_cache_lock "$cache_lock"
  return "$build_status"
}

run_grader() {
  local platform="$1"
  local image_reference="$2"
  local grader_script="$3"
  docker run --rm --network none --platform "$platform" \
    --cpus "$docker_run_cpu_limit" \
    -e GOTOOLCHAIN=local \
    -v "$workspace:/workspace:ro" \
    -v "$grader_dir:/grader:ro" \
    "$image_reference" bash -c "GO_BIN=go /grader/$grader_script /workspace"
}

check_toolchain() {
  local platform="$1"
  local image_reference="$2"
  docker run --rm --network none --platform "$platform" \
    --cpus "$docker_run_cpu_limit" \
    "$image_reference" bash -c 'command -v go >/dev/null && go version >/dev/null'
}

check_default_command() {
  local platform="$1"
  local image_reference="$2"
  local platform_tag="${platform#linux/}"
  local container_name="go-task-cmd-${module_fingerprint}-${platform_tag}-$$-$RANDOM"
  local state status exit_code output
  active_probe_container="$container_name"
  if ! docker create --name "$container_name" --network none --platform "$platform" \
    --cpus "$docker_run_cpu_limit" "$image_reference" >/dev/null; then
    echo "cannot create image with its native CMD: $image_reference ($platform)" >&2
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    active_probe_container=""
    return 1
  fi
  if ! docker start "$container_name" >/dev/null; then
    docker logs "$container_name" >&2 || true
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    active_probe_container=""
    return 1
  fi
  sleep "$startup_probe_seconds"
  state="$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$container_name" 2>/dev/null || true)"
  status="${state%%|*}"
  exit_code="${state#*|}"
  output="$(docker logs "$container_name" 2>&1 || true)"
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  active_probe_container=""
  if [[ "$status" == "running" || ( "$status" == "exited" && "$exit_code" == "0" ) ]]; then
    echo "native CMD startup passed: status=$status exit_code=$exit_code"
    return 0
  fi
  echo "native CMD startup failed: status=${status:-unknown} exit_code=${exit_code:-unknown}" >&2
  [[ -z "$output" ]] || printf '%s\n' "$output" >&2
  return 1
}

run_diagnosis_baseline() {
  local platform="$1"
  local image_reference="$2"
  docker run --rm --network none --platform "$platform" \
    --cpus "$docker_run_cpu_limit" \
    -e GOTOOLCHAIN=local \
    -v "$workspace:/workspace:ro" \
    -v "$grader_dir:/grader:ro" \
    "$image_reference" bash -c '
      set -euo pipefail
      scratch="$(mktemp -d "${TMPDIR:-/tmp}/go-pipeline-baseline.XXXXXX")"
      trap '\''rm -rf "$scratch"'\'' EXIT
      mkdir -p "$scratch/workspace"
      cp -R /workspace/. "$scratch/workspace/"
      while IFS= read -r test_file; do
        [[ -z "$test_file" ]] && continue
        case "$test_file" in
          /*|../*|*/../*|*/..) echo "unsafe verification test path: $test_file" >&2; exit 2 ;;
        esac
        rm -f "$scratch/workspace/$test_file"
      done </grader/test-files.txt
      cd "$scratch/workspace"
      GOTOOLCHAIN=local go test ./... -count=1
    '
}

for platform in "${platforms[@]}"; do
  platform_tag="${platform#linux/}"
  image_reference="${image_stem}-${platform_tag}:latest"
  echo "=== Docker grader $platform ==="
  if ! build_image "$image_reference" "$platform"; then
    echo "FAILURE_CLASS=docker_build" >&2
    exit 93
  fi
  if ! check_toolchain "$platform" "$image_reference"; then
    echo "FAILURE_CLASS=docker_toolchain" >&2
    exit 90
  fi
  echo "--- native CMD startup ($platform) ---"
  if ! check_default_command "$platform" "$image_reference"; then
    echo "FAILURE_CLASS=container_startup" >&2
    exit 96
  fi

  echo "--- $compile_script ($platform) ---"
  if ! run_grader "$platform" "$image_reference" "$compile_script"; then
    echo "FAILURE_CLASS=public_compile" >&2
    exit 91
  fi

  echo "--- run_target.sh ($platform) ---"
  if [[ "$task_type" == "diagnosis" ]]; then
    set +e
    run_grader "$platform" "$image_reference" run_target.sh
    target_exit=$?
    set -e
    if [[ "$target_exit" -eq 0 ]]; then
      echo "diagnosis target unexpectedly passed on $platform" >&2
      exit 97
    fi
    echo "diagnosis target reproduced as expected on $platform (exit=$target_exit)"
  else
    if ! run_grader "$platform" "$image_reference" run_target.sh; then
      echo "FAILURE_CLASS=hidden_target" >&2
      exit 92
    fi
  fi

  echo "--- run_full.sh ($platform) ---"
  if [[ "$task_type" == "diagnosis" ]]; then
    # The repository-owned verification test is intentionally red on BUG_BASE.
    # Validate the unchanged project baseline without that proof-only test.
    full_runner=(run_diagnosis_baseline "$platform" "$image_reference")
  else
    full_runner=(run_grader "$platform" "$image_reference" run_full.sh)
  fi
  if ! "${full_runner[@]}"; then
    echo "FAILURE_CLASS=public_full" >&2
    exit 94
  fi
  if [[ "$task_type" == "bugfix" ]]; then
    echo "--- run_static.sh ($platform) ---"
    if ! run_grader "$platform" "$image_reference" run_static.sh; then
      echo "FAILURE_CLASS=public_static" >&2
      exit 95
    fi
  fi
done

if [[ "$task_type" == "diagnosis" ]]; then
  diff -qr --exclude='.git' "$task_dir/pristine" "$workspace"
fi
echo "Docker grader passed: task_type=$task_type platforms=linux/arm64,linux/amd64"
