# Conversation Session Docker Automation Plan

本文定义 V4 conversation formal E2E 如何进入 Docker 自动化。历史 legacy suite 的运行记录只作为背景，不再代表当前 V4 preset 的准入状态。

## 目标

- 让具备当前 V4 formal 合同且有 Docker `replay-isolated` 证据的 case 能在 `Dockerfile.desktop-e2e` 容器内用一条命令运行。
- 默认 container smoke 暂时保持轻量，避免一次性扩大默认门禁时长和不稳定面。
- 后续只有同时满足本地默认路径通过、Docker `replay-isolated` 通过的 spec，才能加入 Docker conversation suite。

## Docker Presets

普通 suite 名称为 `conversation-session-verified`，只覆盖已经在当前代码与 fixture 上取得 Docker `replay-isolated` 绿色证据的 V4 direct-root formal spec。

截至 2026-08-10，`conversation-session-verified` 当前为空，调用时脚本会明确失败并提示先进行单 spec admission，而不是静默运行空集合或错误的旧路径。Assistant Preview Cards 已完成人工 review、formal promotion 和本地 replay，但其单 spec Docker 尝试在解析 `docker/dockerfile:1.7` 镜像配置时因 Docker Hub token 请求 `EOF` 失败，尚未进入 WDIO `replay-isolated` 执行，因此不能登记为 verified。

CDD01 已迁入 formal 路径，但单 spec Docker `replay-isolated` 运行
`packages/desktop/.e2e-artifacts/desktop-e2e-20260810-122428-44907/summary.md` 为 `0/1 failed`：
复制 `.zcode/v2` 时与 `setting.json` 原子写入发生竞态，瞬时消失的 `setting.json.lock` 导致
`ENOENT`。该失败已进入 WDIO，不是基础设施阻断，也不是绿色 admission 证据，因此不能登记为 verified。

2026-08-11 修复复制过滤后重新执行同一单 spec，
`packages/desktop/.e2e-artifacts/desktop-e2e-20260811-080633-76555/summary.md` 为 `1/1 passed`，
确认 `setting.json` 原子写入的 lock/临时文件不会再阻断迁移。该 artifact 目前只证明
`replay-isolated` 通过；在人工 review、正式 admission apply 完成前，仍不写入
`conversation-session-verified` preset。

历史 `conversation-session-admission`、`conversation-session-needs-docker-fix` 和 `conversation-session-tool-cross-product` preset 已删除。需要定位某个 case 时统一使用 `E2E_SPEC` 指定 direct-root spec；只有取得绿色证据后才能用 `e2e:docker:admit` 登记到 verified 集合。

| Spec | 迁移状态 |
| ---- | -------- |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-amend.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-artifacts.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-compile.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-confirm.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-cross-session.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-english-dark.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-lookup.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-notify.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-overflow.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-questions.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-restart.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-resume.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-run-pane-details.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-run-permissions.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-run.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-save-from-chat.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-save-window.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-snippet.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-stop.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-transcript.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on-user-choice.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-disabled.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-on-demand.test.ts` | verified |
| `./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-holes.test.ts` | verified |
<!-- conversation-session-verified-table-end -->

运行入口：

```bash
pnpm run test:e2e:container:conversation
```

分别等价于：

```bash
E2E_SPEC_PRESET=conversation-session-verified pnpm run test:e2e:container
```

## Suite 批量运行策略

`conversation-session-verified` 在至少一个 V4 formal case 完成 Docker admission 后才可作为批量回归入口。脚本把 suite 内 spec 作为逗号分隔的 `ZCODE_E2E_SPEC` 传给同一次 WDIO 运行，复用同一个镜像、同一次容器启动、同一次 desktop app / agent server 构建。

单 spec Docker 运行只用于准入证明和失败定位：

- 新 case 进入 suite 前，先单独跑一次 `replay-isolated`，确认自身 fixture、文件系统和
  Docker 环境都闭环。
- 已进入 suite 后，常规 CI 和批量验证跑 `pnpm run test:e2e:container:conversation`。
- 只有真实 capture、故障注入、性能/时序敏感、会污染全局配置或需要特殊网络/文件系统
  的 case，才拆到独立 preset 或独立 Docker 运行。

## 单 Case 准入

新增正式 spec 不直接改 preset。先用单 spec 在 Docker 断网 replay 下证明：

```bash
E2E_SPEC=./test/e2e/conversation-session/<case>.test.ts \
  pnpm run test:e2e:container
```

新 spec 首次准入不要设置 `SKIP_IMAGE_BUILD=1`：Docker 镜像会拷贝当前工作树，旧镜像里
没有新 spec 或新 fixture 时，WDIO 会报 `pattern ... did not match any file`。同一个
镜像已经包含该 spec 后，后续复跑才适合使用 `SKIP_IMAGE_BUILD=1` 加速。

通过后再登记进 `conversation-session-verified`：

```bash
pnpm --filter @zcode/desktop e2e:docker:admit -- \
  --spec ./test/e2e/conversation-session/<case>.test.ts \
  --verified \
  --artifact packages/desktop/.e2e-artifacts/<run-id> \
  --apply
```

`e2e:docker:admit` 会同步 `scripts/test-desktop-e2e-container.sh` 和本文的 suite 表格。
它只接受正式路径下的 spec；`manual-review/pending` 仍然禁止直接进入 Docker preset。
表格准入按列结构和结束标记验证，不依赖分隔线的横线数量或标记前的空行。
新增 verified 行必须与表头和已有行连续，不能被格式化产生的空行隔成表外文本；
写入保留文档的 LF/CRLF 换行，重复登记同一 spec 不新增行。

## 历史运行记录（已失效的 legacy 路径）

以下记录发生在 V4 formal 目录重整之前，证明的是当时文件与 fixture 的 Docker 行为。相关 spec 后来已经移动到 `manual-review/pending`，因此这些结果不能登记为当前 V4 direct-root formal 的 verified 证据，也不能恢复成 preset 路径。

2026-06-24 在 `staging` 上执行 `pnpm run test:e2e:container:conversation`，产物目录：
`packages/desktop/.e2e-artifacts/desktop-e2e-20260624-103921-58999`。

这次验证在 Docker `replay-isolated` 下跑完当时的 13 个 conversation-session spec：
8 个通过，5 个失败。失败项当时移入现已删除的 `needs-docker-fix` preset，8 个通过项当时进入旧绿色 preset；两者都不是当前 V4 verified 集合。

2026-06-24 在 `staging` 上执行
`SKIP_IMAGE_BUILD=1 SKIP_DRIVER_PREFETCH=1 pnpm run test:e2e:container:conversation`，
产物目录：`packages/desktop/.e2e-artifacts/desktop-e2e-20260624-105312-79607`。

这次验证在 Docker `replay-isolated` 下跑完 8 个绿色 spec：8 个通过，0 个失败，
总耗时 3 分 35 秒。

2026-06-24 在 `staging` 上执行
`E2E_SPEC=./test/e2e/conversation-session/execution/conversation-session-running-actions.test.ts pnpm run test:e2e:container`，
产物目录：`packages/desktop/.e2e-artifacts/desktop-e2e-20260624-110228-90545`。

这次使用当前工作树重建 Docker 镜像后，`conversation-session-running-actions` 单 spec
在 Docker `replay-isolated` 下通过：1 个通过，0 个失败，WDIO 耗时 19 秒。

2026-06-24 在 `staging` 上执行
`SKIP_IMAGE_BUILD=1 SKIP_DRIVER_PREFETCH=1 pnpm run test:e2e:container:conversation`，
产物目录：`packages/desktop/.e2e-artifacts/desktop-e2e-20260624-110705-92301`。

这次验证在 Docker `replay-isolated` 下跑完 9 个绿色 spec，包含新加入的
`conversation-session-running-actions`：9 个通过，0 个失败，WDIO 总耗时 3 分 54 秒。

2026-07-09 在 `feat/markdown-table-inline-scroll` 上执行
`E2E_SPEC=./test/e2e/conversation-session/presentation/conversation-session-markdown-table-enhanced-scroll.test.ts pnpm run test:e2e:container`。

这次 Docker 准入没有进入 WDIO replay：镜像构建阶段 `apt-get install` 从 `deb.debian.org`
拉取多个 Debian 包时持续返回 `400 Bad Request [IP: 198.18.0.158 80]`，build 在
`Dockerfile.desktop-e2e` 的系统依赖安装层以 exit code 100 失败。该结果不能作为
`conversation-session-markdown-table-enhanced-scroll` 的 Docker replay 结论；case 当前已完成
正式路径、本地 default replay、case-local fixture replay 和 `e2e:fixture:check`。

2026-07-09 该 case 没有取得 Docker admission。`verified-local-docker-skipped` 只代表当时正式路径和本地 replay 已转正，不代表 Docker `replay-isolated` 已验证；若要进入当前 verified 集合，必须基于当前 direct-root spec、manifest 和 fixture 重跑单 spec admission。

## 网络与远控边界

- 默认使用 `E2E_NETWORK_MODE=replay-isolated`，容器内不访问真实 DeepSeek 上游。
- 该 suite 只覆盖桌面端 `desktop-continuous` conversation 行为。
- 手机 `/remote` 的 `web-remote-replayable` 恢复语义不由本 suite 验证，仍走远控专项回归。

## 后续准入规则

新增 spec 进入 `conversation-session-verified` 前需要同时满足：

1. spec 已经从 `manual-review/pending` 迁移到 `packages/desktop/test/e2e/conversation-session/`。
2. 本地默认路径下目标 spec 通过。
3. Docker `replay-isolated` 下目标 spec 通过，并在运行记录或 PR 描述中保留 artifact 路径。
4. `docs/testing/conversation-session-e2e-coverage-matrix.md` 已经指向默认路径。
5. 使用 `e2e:docker:admit` 登记进 `conversation-session-verified` preset。

`manual-review/pending` 下的 spec 禁止直接加入 Docker preset。
