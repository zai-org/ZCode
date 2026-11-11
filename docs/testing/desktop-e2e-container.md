# Desktop E2E Container Demo

这个 demo 用 Linux 容器运行桌面端 WebdriverIO Electron E2E。默认 case 只验证容器 headless 基础链路：Electron 能在虚拟显示里启动主窗口，并创建默认工作区。

## 运行

```bash
pnpm run test:e2e:container
```

默认运行轻量容器 smoke 集合：

- `packages/desktop/test/e2e/infrastructure/smoke/container-boot.test.ts`
- `packages/desktop/test/e2e/infrastructure/smoke/smoke.test.ts`
- `packages/desktop/test/e2e/infrastructure/smoke/e2ecase-regression.test.ts`
- `packages/desktop/test/e2e/infrastructure/smoke/upstream-provider.test.ts`
- `packages/desktop/test/e2e/ui-shell/navigation/task-list-archive-confirmation.test.ts`

DeepSeek provider case 默认使用 fixture replay，不访问真实上游；只有显式设置 `E2E_PROVIDER_HTTP_MODE=capture` 时才会要求真实 key。
这样容器链路不再只是 boot demo，而是覆盖当前桌面端核心 e2e 集合。
运行完成后会在 `packages/desktop/.e2e-artifacts/<run-id>/` 生成测试报告和性能采样文件：

- `summary.md`：人工可读摘要，包含 case 结果、Electron 进程采样摘要和容器资源摘要
- `summary.json`：机器可读摘要
- `test-results.ndjson`：逐 case 结果
- `perf/process-samples-*.ndjson`：Electron main / renderer / GPU / utility 进程 CPU、内存采样
- `perf/container-samples.ndjson`：Docker CPU、内存、网络 IO、块 IO 采样

需要查看 HTML 报告时，先启动 Vite viewer：

```bash
pnpm dev:e2e-report
```

然后打开 `summary.md` 或 `summary.json` 里的 `files.viewerUrl`。

默认采样间隔是 3 秒，可通过 `PERF_SAMPLE_INTERVAL_SECONDS=5` 调整容器采样间隔。Electron 进程采样间隔由 `ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS` 控制；如果希望容器和 Electron 曲线按同一节奏采样，可以这样运行：

```bash
ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS=1000 \
PERF_SAMPLE_INTERVAL_SECONDS=1 \
pnpm run test:e2e:container
```

Electron 指标只有在 WDIO Electron session ready 后才能采集，短 boot demo 可能只有开始/结束点；运行更长的 regression case 时会形成连续 CPU / memory 趋势。

## 覆盖 spec

```bash
E2E_SPEC=./test/e2e/infrastructure/smoke/smoke.test.ts pnpm run test:e2e:container
```

## Conversation session suite

conversation session 使用独立的 Docker verified preset。当前 38 个 V4 formal case 尚未在本轮取得 Docker `replay-isolated` 证据，因此 verified 集合为空；下列命令会在访问 Docker daemon 之前以 exit 2 明确提示先做单 case admission：

```bash
pnpm run test:e2e:container:conversation
```

也可以直接指定 preset：

```bash
E2E_SPEC_PRESET=conversation-session-verified pnpm run test:e2e:container
```

verified preset 只允许引用 `packages/desktop/test/e2e/conversation-session/` 下当前代码与 fixture 已通过 Docker admission 的 spec，不引用 `manual-review/pending`，也不继承 legacy suite 的历史结果。准入规则见
[conversation-session-docker-automation-plan.md](./conversation-session-docker-automation-plan.md)。
新增正式 spec 先用单 spec Docker replay 证明：

```bash
E2E_SPEC=./test/e2e/conversation-session/<case>.test.ts \
  pnpm run test:e2e:container
```

通过后用准入工具登记：

```bash
pnpm --filter @zcode/desktop e2e:docker:admit -- \
  --spec ./test/e2e/conversation-session/<case>.test.ts \
  --verified \
  --artifact packages/desktop/.e2e-artifacts/<run-id> \
  --apply
```

`smoke.test.ts` 会进一步验证 renderer 是否进入可交互工作区主界面；如果它失败，应按普通桌面 E2E 问题继续排查，不把 workaround 写进业务默认路径。

首次运行会下载 Electron 对应的 Chromedriver，并缓存到 Docker volume。默认平台是 `linux/amd64`，默认缓存名是 `zcode-desktop-e2e-driver-cache-linux-amd64`；后续运行会复用缓存。需要调整时可使用：

```bash
DOCKER_PLATFORM=linux/amd64 \
DRIVER_CACHE_VOLUME=my-zcode-e2e-driver-cache \
DRIVER_PREFETCH_TIMEOUT=600 \
pnpm run test:e2e:container
```

默认脚本每次都会执行一次 `docker build`，这样新增或修改的 e2e case 会被复制进镜像；Docker 会复用已有 layer cache。确认镜像内容没变、只是想重复运行同一批 case 时，可以跳过 build：

```bash
SKIP_IMAGE_BUILD=1 \
pnpm run test:e2e:container
```

如果新增了 case、改了测试 helper、改了业务源码或依赖配置，不要跳过 build；否则容器里运行的还是旧镜像内容。

需要固定报告目录时可使用：

```bash
ZCODE_E2E_RUN_ID=my-regression-run \
E2E_ARTIFACT_DIR=/tmp/zcode-e2e-report \
pnpm run test:e2e:container
```

DeepSeek provider 固定回归默认使用 fixture replay，不需要真实 key：

```bash
E2E_SPEC=./test/e2e/infrastructure/smoke/upstream-provider.test.ts \
pnpm run test:e2e:container
```

需要采集真实 GLM highspeed 流式数据时，再显式切到 capture 模式并传入 key：

```bash
E2E_PROVIDER_HTTP_MODE=capture \
E2E_PROVIDER_PRESET=glmhighspeed \
GLM_HIGHSPEED_E2E_API_KEY=... \
E2E_SPEC=./test/e2e/infrastructure/smoke/upstream-provider.test.ts \
pnpm run test:e2e:container
```

## 技术边界

- 镜像基于 `node:24.14.0-bookworm`，预装 Electron/Chromium 在 Linux 下需要的 GTK、X11、字体、DBus 和 `xvfb` 依赖。
- 启动脚本默认使用 `linux/amd64`，让 Electron、Chrome-for-Testing Chromedriver 和系统动态链接器保持同一架构；在 Apple Silicon 上由 Docker Desktop 负责整容器模拟。
- `packages/desktop/wdio.conf.ts` 只在 `ZCODE_E2E_CONTAINER=1` 时启用容器参数，包括 WDIO Xvfb 重试和 Chromium 测试参数。
- 容器模式固定 WDIO Chromedriver cache 到 `/workspace/.cache/wdio-browser-drivers`，启动脚本通过 Docker volume 复用缓存，避免每轮测试都依赖即时网络下载。
- 这个 demo 不验证手机 `/remote` 的 `web-remote-replayable` 恢复语义；远控链路应继续使用独立的 web/mobile 回归。
