# File Tools Atomic Write E2E Coverage Matrix

## 范围

本矩阵覆盖 CLI file tools 到 `NodeFileSystemAdapter.writeTextFile` 的真实文件系统路径，目标是防止 `Write` / `Edit` 修改已有可执行脚本后丢失执行位。

本矩阵分两层：`FT-AW-01` 至 `FT-AW-03` 是 CLI/adapter 层的确定性回归，不进入 conversation-session 的 `manual-review/pending` 流程；`FT-AW-04` 是待人工复核和重新晋级的 conversation-session replay 候选，使用 case-local DeepSeek fixture 和 case manifest 验证真实桌面会话里的权限行为，但不属于默认质量门禁。

实现口径：`NodeFileSystemAdapter` 的默认 `atomic: true` 写入使用 `O_NOFOLLOW` temp 文件、复制原文件权限、sync、rename；若 atomic 路径失败，会清理 temp 并 fallback 到 `O_TRUNC` 非原子写目标文件。这个 fallback 在异常磁盘错误下可能截断已有目标；本轮权限回归暂接受这一行为，不在实现里加入额外兜底或 fault-injection hook。

本矩阵只覆盖权限保留和 symlink 拒绝；不覆盖 `ZCODE_E2E_FS_FAULTS`、atomic temp/rename 失败恢复或磁盘满语义。相关存储故障仍归属 `D02` 产品语义确认。

## Case Index

| ID | 状态 | Spec / harness | Setup | Action | Assertion |
| --- | --- | --- | --- | --- | --- |
| FT-AW-01 | covered | `apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs` / `write-preserves-executable-mode` | POSIX 临时 workspace；已有 `0755` 的 `write.sh`；为 `Write` 准备 read state | 调用 built dist `writeToolEntry.handler` 覆盖文件内容 | 文件内容更新；mode 仍为 `0755` |
| FT-AW-02 | covered | `apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs` / `edit-preserves-executable-mode` | POSIX 临时 workspace；已有 `0755` 的 `edit.sh` | 调用 built dist `editToolEntry.handler` 替换文本 | 文件内容更新；mode 仍为 `0755` |
| FT-AW-03 | covered | `apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs` / `write-rejects-symlink-target` | POSIX 临时 workspace；`link.sh` 指向 `target.sh` | 调用 built dist `writeToolEntry.handler` 写入 symlink 路径 | 抛出 `Refusing to write through symlink: ...`；真实 target 内容未被改写 |
| FT-AW-04 | partial | `packages/desktop/test/e2e/conversation-session/tools/conversation-session-file-tools-atomic-write.test.ts` / `Write 和 Edit 修改可执行脚本后应保留 POSIX 执行位` | Electron/WDIO 默认 workspace；两个已有 `0755` 脚本；case-local provider replay 固定 `Read -> Write -> Read -> Edit` | 通过 UI 发送 prompt，真实 conversation runtime 执行 `Write` 和 `Edit` tool handler | 候选 spec 已有 UI、内容与 mode 断言；需按当前 V4 行为人工复核并晋级后才能计入默认 E2E 门禁 |

## 运行命令

从 repo root 执行：

```bash
pnpm --filter @zcode/contracts build
pnpm --filter @zcode/shared-types build
pnpm --filter @zcode/adapters build
pnpm --filter @zcode/core build
node apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs
```

`run.mjs` 在 Windows 上会返回 skipped，因为 Windows 没有和 POSIX `0755` 相同的 mode 语义。

窗口级 replay E2E：

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/tools/conversation-session-file-tools-atomic-write.test.ts
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-file-tools-atomic-write.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/tools/conversation-session-file-tools-atomic-write.test.ts'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/tools/conversation-session-file-tools-atomic-write.test.ts'
```

若后续要把 `FT-AW-04` 纳入 `conversation-session-verified` Docker suite，再执行容器准入：

```bash
E2E_SPEC=./test/e2e/conversation-session/tools/conversation-session-file-tools-atomic-write.test.ts pnpm run test:e2e:container
pnpm --filter @zcode/desktop e2e:docker:admit -- --spec ./test/e2e/conversation-session/tools/conversation-session-file-tools-atomic-write.test.ts --verified --artifact packages/desktop/.e2e-artifacts/<run-id> --apply
pnpm run test:e2e:container:conversation
```

## Lifecycle Decision

- `manual-review/pending`：`FT-AW-04` 当前位于该目录，只能作为候选证据。语义虽来自已确认的文件系统 bugfix，仍需按当前 V4 回放完成 review 后再晋级。
- `fixtures/upstream` / `fixtures/cases`：`FT-AW-01` 至 `FT-AW-03` 不使用；`FT-AW-04` 必须使用 case-local provider fixture 和 case manifest，固定 `Read -> Write -> Read -> Edit` 的工具调用合同。
- `e2e:fixture:check`：`FT-AW-04` 必跑，用来证明 fixture、manifest、spec marker 和请求合同一致。
- `e2e:promote`：人工确认当前 V4 UI / network / snapshot 断言稳定后，用该流程把 `FT-AW-04` 晋级回默认 conversation-session 目录，并同步本矩阵状态。
- Docker admission：仅在 `FT-AW-04` 需要进入 `conversation-session-verified` 容器 suite 时使用；进入前必须先通过单 spec `replay-isolated`，再用 `e2e:docker:admit` 同步 Docker preset 和准入文档。
- `pnpm --filter @zcode/desktop typecheck:e2e`：作为 lifecycle 收尾门禁保留，防止 E2E 类型环境被本次测试设施改动破坏。
