#!/usr/bin/env bash

set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-zcode-desktop-e2e-demo}"
DOCKERFILE="${DOCKERFILE:-Dockerfile.desktop-e2e}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
PNPM_VERSION="${PNPM_VERSION:-10.33.2}"
DEFAULT_E2E_SPEC="./test/e2e/infrastructure/smoke/container-boot.test.ts,./test/e2e/infrastructure/smoke/smoke.test.ts,./test/e2e/infrastructure/smoke/e2ecase-regression.test.ts,./test/e2e/infrastructure/smoke/upstream-provider.test.ts,./test/e2e/ui-shell/navigation/task-list-archive-confirmation.test.ts"
# 修复原因：formal/local replay 通过不等于 Docker admission；只有取得 replay-isolated 绿色证据的 spec 才写入。
CONVERSATION_SESSION_VERIFIED_E2E_SPEC="./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-amend.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-artifacts.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-compile.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-confirm.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-cross-session.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-english-dark.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-lookup.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-notify.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-overflow.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-questions.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-restart.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-resume.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-run-pane-details.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-run-permissions.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-run.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-save-from-chat.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-save-window.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-snippet.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-stop.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-transcript.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-user-choice.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-disabled.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-on-demand.test.ts,./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-holes.test.ts"
# 只有通过人工 review、formal promotion 和单 spec Docker admission 的插件用例才能写入。
PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC="./test/e2e/plugins/runtime/plugin-ui-session-ready.test.ts"
E2E_SPEC_PRESET="${E2E_SPEC_PRESET:-}"
if [ "$#" -gt 1 ]; then
  printf '[desktop-e2e-container] expected at most one preset argument\n' >&2
  exit 1
fi
if [ "$#" -eq 1 ]; then
  if [ -n "$E2E_SPEC_PRESET" ] && [ "$E2E_SPEC_PRESET" != "$1" ]; then
    printf '[desktop-e2e-container] preset argument conflicts with E2E_SPEC_PRESET: %s != %s\n' "$1" "$E2E_SPEC_PRESET" >&2
    exit 1
  fi
  E2E_SPEC_PRESET="$1"
fi

case "$E2E_SPEC_PRESET" in
  "" | default)
    PRESET_E2E_SPEC="$DEFAULT_E2E_SPEC"
    ;;
  conversation-session-verified)
    if [ -z "$CONVERSATION_SESSION_VERIFIED_E2E_SPEC" ]; then
      printf '[desktop-e2e-container] No V4 conversation-session spec has Docker replay-isolated admission evidence; run a formal spec with E2E_SPEC first, then use e2e:docker:admit after it passes.\n' >&2
      exit 2
    fi
    PRESET_E2E_SPEC="$CONVERSATION_SESSION_VERIFIED_E2E_SPEC"
    ;;
  plugins-verified)
    if [ -z "$PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC" ]; then
      printf '[desktop-e2e-container] No plugin-management spec has completed human review and Docker admission; run a promoted formal spec with E2E_SPEC first, then use e2e:docker:admit:plugins.\n' >&2
      exit 2
    fi
    PRESET_E2E_SPEC="$PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC"
    ;;
  *)
    printf '[desktop-e2e-container] unsupported E2E_SPEC_PRESET: %s\n' "$E2E_SPEC_PRESET" >&2
    printf '[desktop-e2e-container] expected one of: default, conversation-session-verified, plugins-verified\n' >&2
    exit 1
    ;;
esac
E2E_SPEC="${E2E_SPEC:-$PRESET_E2E_SPEC}"
E2E_NETWORK_MODE="${E2E_NETWORK_MODE:-replay-isolated}"
SHM_SIZE="${SHM_SIZE:-2g}"
DEFAULT_DRIVER_CACHE_VOLUME="zcode-desktop-e2e-driver-cache-${DOCKER_PLATFORM//\//-}"
DRIVER_CACHE_VOLUME="${DRIVER_CACHE_VOLUME:-$DEFAULT_DRIVER_CACHE_VOLUME}"
DRIVER_CACHE_DIR="${DRIVER_CACHE_DIR:-/workspace/.cache/wdio-browser-drivers}"
DRIVER_PREFETCH_TIMEOUT="${DRIVER_PREFETCH_TIMEOUT:-300}"
E2E_RUN_ID="${ZCODE_E2E_RUN_ID:-desktop-e2e-$(date -u +%Y%m%d-%H%M%S)-$$}"
E2E_ARTIFACT_ROOT="${E2E_ARTIFACT_ROOT:-$PWD/packages/desktop/.e2e-artifacts}"
HOST_ARTIFACT_DIR="${E2E_ARTIFACT_DIR:-$E2E_ARTIFACT_ROOT/$E2E_RUN_ID}"
CONTAINER_ARTIFACT_DIR="/workspace/packages/desktop/.e2e-artifacts/$E2E_RUN_ID"
CONTAINER_NETWORK_CAPTURE_DIR="$CONTAINER_ARTIFACT_DIR/network-capture"
CONTAINER_NAME="${CONTAINER_NAME:-zcode-desktop-e2e-${E2E_RUN_ID}}"
PERF_SAMPLE_INTERVAL_SECONDS="${PERF_SAMPLE_INTERVAL_SECONDS:-3}"
CONTAINER_STATS_PATH="$HOST_ARTIFACT_DIR/perf/container-samples.ndjson"

log() {
  printf '[desktop-e2e-container] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[desktop-e2e-container] missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_command docker

if ! docker info >/dev/null 2>&1; then
  printf '[desktop-e2e-container] Docker daemon is not reachable; please start Docker and retry.\n' >&2
  exit 1
fi

if [ ! -f "$DOCKERFILE" ]; then
  printf '[desktop-e2e-container] Dockerfile not found: %s\n' "$DOCKERFILE" >&2
  exit 1
fi

case "$E2E_NETWORK_MODE" in
  replay-isolated | bridge | capture)
    ;;
  *)
    printf '[desktop-e2e-container] unsupported E2E_NETWORK_MODE: %s\n' "$E2E_NETWORK_MODE" >&2
    printf '[desktop-e2e-container] expected one of: replay-isolated, bridge, capture\n' >&2
    exit 1
    ;;
esac

if [ "$E2E_NETWORK_MODE" = "replay-isolated" ] && [ "${E2E_PROVIDER_HTTP_MODE:-replay}" = "capture" ]; then
  printf '[desktop-e2e-container] replay-isolated cannot be used with E2E_PROVIDER_HTTP_MODE=capture\n' >&2
  exit 1
fi

if [ "$E2E_NETWORK_MODE" = "capture" ]; then
  if [ -z "${E2E_PROVIDER_API_KEY:-}" ] || [ "${E2E_PROVIDER_API_KEY:-}" = "xxx" ]; then
    printf '[desktop-e2e-container] E2E_NETWORK_MODE=capture requires a real E2E_PROVIDER_API_KEY\n' >&2
    exit 1
  fi
  if [ "${E2E_PROVIDER_PRESET:-env}" = "env" ] && [ -z "${E2E_PROVIDER_BASE_URL:-}" ]; then
    printf '[desktop-e2e-container] E2E_NETWORK_MODE=capture requires E2E_PROVIDER_BASE_URL\n' >&2
    exit 1
  fi
fi

mkdir -p "$HOST_ARTIFACT_DIR/perf" "$HOST_ARTIFACT_DIR/network-capture"

if [ "${SKIP_IMAGE_BUILD:-0}" = "1" ]; then
  if ! docker image inspect "${IMAGE_NAME}:latest" >/dev/null 2>&1; then
    printf '[desktop-e2e-container] SKIP_IMAGE_BUILD=1 but image not found: %s:latest\n' "$IMAGE_NAME" >&2
    exit 1
  fi
  log "skipping image build for ${IMAGE_NAME}:latest"
else
  log "building ${IMAGE_NAME}:latest with ${DOCKERFILE} for ${DOCKER_PLATFORM}"
  DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}" docker build \
    --platform "$DOCKER_PLATFORM" \
    -f "$DOCKERFILE" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    -t "${IMAGE_NAME}:latest" \
    .
fi

if [ "${SKIP_DRIVER_PREFETCH:-0}" != "1" ]; then
  log "prefetching Chromedriver into volume ${DRIVER_CACHE_VOLUME}"
  docker run \
    --rm \
    --platform "$DOCKER_PLATFORM" \
    -e "DRIVER_PREFETCH_TIMEOUT=${DRIVER_PREFETCH_TIMEOUT}" \
    -e "WDIO_BROWSER_DRIVER_CACHE_DIR=${DRIVER_CACHE_DIR}" \
    -v "${DRIVER_CACHE_VOLUME}:${DRIVER_CACHE_DIR}" \
    "${IMAGE_NAME}:latest" \
    bash -lc '
      set -euo pipefail
      timeout "${DRIVER_PREFETCH_TIMEOUT}s" node packages/desktop/scripts/chromedriver-preflight.mjs prepare "${WDIO_BROWSER_DRIVER_CACHE_DIR}"
    '
fi

# 预取选择的补丁可能不同于 Chromium 精确补丁；离线运行必须读取实际路径，不能再次联网猜版本。
CHROMEDRIVER_BINARY="$(docker run --rm --platform "$DOCKER_PLATFORM" \
  -v "${DRIVER_CACHE_VOLUME}:${DRIVER_CACHE_DIR}" "${IMAGE_NAME}:latest" \
  node packages/desktop/scripts/chromedriver-preflight.mjs path "$DRIVER_CACHE_DIR")"
if [ -z "$CHROMEDRIVER_BINARY" ]; then
  printf '[desktop-e2e-container] Chromedriver cache path is empty; run prefetch again.\n' >&2
  exit 1
fi

docker_run_args=(
  --name "$CONTAINER_NAME"
  --platform "$DOCKER_PLATFORM"
  --shm-size "$SHM_SIZE"
  -e CI=1
  -e "CHROMEDRIVER_PATH=${CHROMEDRIVER_BINARY}"
  -e ZCODE_E2E_CONTAINER=1
  -e "ZCODE_E2E_RUN_ID=${E2E_RUN_ID}"
  -e "ZCODE_E2E_ARTIFACT_DIR=${CONTAINER_ARTIFACT_DIR}"
  -e "ZCODE_E2E_NETWORK_CAPTURE_DIR=${CONTAINER_NETWORK_CAPTURE_DIR}"
  -e "ZCODE_E2E_SPEC=${E2E_SPEC}"
  -v "${DRIVER_CACHE_VOLUME}:${DRIVER_CACHE_DIR}"
  -v "${HOST_ARTIFACT_DIR}:${CONTAINER_ARTIFACT_DIR}"
)

case "$E2E_NETWORK_MODE" in
  replay-isolated)
    docker_run_args+=(--network none)
    docker_run_args+=(-e "E2E_PROVIDER_HTTP_MODE=replay")
    ;;
  bridge)
    docker_run_args+=(-e "E2E_PROVIDER_HTTP_MODE=${E2E_PROVIDER_HTTP_MODE:-replay}")
    ;;
  capture)
    docker_run_args+=(-e "E2E_PROVIDER_HTTP_MODE=capture")
    ;;
esac

if [ -n "${EXTRA_WDIO_ARGS:-}" ]; then
  docker_run_args+=(-e "EXTRA_WDIO_ARGS=${EXTRA_WDIO_ARGS}")
fi

if [ -n "${E2E_PROVIDER_API_KEY:-}" ]; then
  docker_run_args+=(-e "E2E_PROVIDER_API_KEY=${E2E_PROVIDER_API_KEY}")
fi

# 修复：E2E 上游供应商由环境变量配置后，容器只转发了 API key，抓包模式拿不到上游地址与模型必然失败。
for provider_env_name in E2E_PROVIDER_BASE_URL E2E_PROVIDER_MODEL E2E_PROVIDER_SECONDARY_MODEL \
  E2E_PROVIDER_PRESET E2E_PROVIDER_THOUGHT_LEVEL E2E_PROVIDER_SECONDARY_THOUGHT_LEVEL; do
  if [ -n "${!provider_env_name:-}" ]; then
    docker_run_args+=(-e "${provider_env_name}=${!provider_env_name}")
  fi
done

sample_container_stats() {
  while true; do
    if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
      stats_json="$(docker stats --no-stream --format '{{json .}}' "$CONTAINER_NAME" 2>/dev/null || true)"
      if [ -n "$stats_json" ]; then
        printf '{"capturedAt":"%s","stats":%s}\n' \
          "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          "$stats_json" >> "$CONTAINER_STATS_PATH"
      fi
    fi
    sleep "$PERF_SAMPLE_INTERVAL_SECONDS"
  done
}

cleanup_container() {
  if [ -n "${stats_sampler_pid:-}" ]; then
    kill "$stats_sampler_pid" >/dev/null 2>&1 || true
    wait "$stats_sampler_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

trap cleanup_container EXIT
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

log "running ${E2E_SPEC}; network=${E2E_NETWORK_MODE}; artifacts: ${HOST_ARTIFACT_DIR}"
sample_container_stats &
stats_sampler_pid=$!

docker run "${docker_run_args[@]}" "${IMAGE_NAME}:latest"
