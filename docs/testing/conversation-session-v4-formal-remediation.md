# V4 Conversation Formal Replay Remediation

## 背景与证据

2026-07-11 使用 non-recursive formal glob 和严格 provider 池执行了第一轮 desktop non-Docker replay：

- formal spec：29；实际 worker：29；`manual-review/pending`：0。
- provider fixture：`common.json` + 29 个 case-local fixture；未加载 `provider-basic` 或 tool-cross fallback。
- run id：`task6-strict-20260711`。
- 结果：34 tests，20 passed，14 failed；15 个 spec 全绿，14 个 spec 至少一条失败。

这 14 条失败不降级回 pending，也不通过提高 timeout、固定英文文案或恢复 legacy shared fixture 变绿。它们继续作为 formal contract，按以下根因组修复后重新执行严格 batch。

## 统一权威边界

```text
CLI / V4 snapshot authority
          |
          v
canonical UI materialization
  ├─ row/marker semantic data attributes
  ├─ status-panel shell attributes
  ├─ one visible split-layout owner
  └─ row-count / render-unit-count separate units
          |
          v
formal E2E helpers
  └─ read stable ids/attributes and perform current user interaction
```

E2E 不允许再次把旧调试 DOM、i18n 文案、隐藏 child 元素或旧 localStorage owner 当成产品权威。

## 失败分组与修复决策

| Formal spec | 直接失败 | 根因定性 | 修复合同 |
| --- | --- | --- | --- |
| `v4-edit` | edited reply 未出现 | E2E 仍把 newText 写入主 composer；当前产品要求行内 Edit → 行内输入 → 行内 Send | helper 精确解析 user rowId，使用 `v4-edit-input/submit-${rowId}`；保留 rewind/rerun 强断言 |
| `v4-fork-edit-branch` | edited reply 未出现 | 与 `v4-edit` 同源 | 复用同一行内 edit helper，再证明 fork child 只有新分支 |
| `v4-compact` | 等待 `[compact]` | 旧 debug 文本 oracle；V4 实际 marker status 为 `success` | timeline row 暴露 marker type/status/origin；helper 断言结构化属性，不断言英文/中文文案 |
| `v4-background-work` | running item 永不出现 | unified status panel 在窄 pane 为 mini，item 只在展开的“终端/智能体”对应区块挂载；cancelled 后 running item 应消失 | 先读 panel shell typed running count，再展开对应区块；取消后断言 ACK 和 item 消失 |
| `v4-goal` | 旧 goal banner 永不出现 | goal 已迁移到 unified status panel，旧 banner/TID 无生产引用 | panel shell 在 mini/expanded 都暴露 goal objective/status；helper pane-scoped 读取 |
| `v4-delete` | delete TID 缺失 | WIP header 精简误删冻结协议的 UI 入口和 SessionPane command 接线 | 恢复 touch-accessible delete action；accepted/noop 后才回 draft，failed 不回 draft |
| `v4-rename` | rename input 缺失 | 与 delete 同一 WIP 精简误删 | 恢复 header rename input/submit 与 `renameSession` ACK 接线 |
| `v4-sidebar` | rename input 缺失 | 与 rename 同源 | 恢复入口后继续验证 sessions-index custom title 与 delete 后列表收口 |
| `v4-load-older` | raw rows 期望 70，收到 unit count 1 | `data-row-count` 已从 raw projection rows 漂移成 turn render units；单 turn 70 blocks 又无法证明分页 | 分离 window/raw total/render unit/mounted unit；fixture 改为多 completed turns；anchor 以 turn unit 验证 |
| `v4-scroll` | raw rows 期望 50，收到 unit count 1 | 与 load-older 同源；单 turn 无法形成稳定长列表 | 多 turn 历史 + controlled-stream 新 turn；不同计数单位禁止互比 |
| `v4-split-persist` | refresh 后 ratio 无法恢复 | draft split promote 为 group 后仍保留 paneLayout shadow owner，divider 写错 store | promotion 成功即消费 source layout；group 自己持久化 ratio；remote compact 不启用 group |
| `v4-split` | close 后 pane 复活 | group GC 后 fallback 到未清理 shadow split | 与 split-persist 同一 ownership transfer 根修；close 后只剩 single pane |
| `v4-stop-queue` B08 | provider request failed | draft prewarm ACK pending 时立即首发，fallback 创建会话只读取尚未水合的 `draftConfigRef`，丢失 provider/model/thought 后误落 builtin/真实请求 | fallback 统一合并同步 initial config → 用户 draft config → app followupMode；pending-prewarm 单测和 B08 strict E2E 同时守门 |
| `v4-turn-navigator` | `Browser.getWindowForTarget` unknown command | WDIO/Electron window rect API 与当前 ChromeDriver 不兼容 | 复用跨平台可工作的 viewport helper；不改产品 turn navigator 语义 |

## 可见投影与测试属性

- V4 `timelineMarker` row 根必须暴露 `data-row-kind="timelineMarker"`、`data-marker-type`、`data-status`；compact 还暴露 `data-origin`。
- unified status panel shell 必须在 `mini` / `panel` 两种视觉分支保持同一语义属性：goal status/objective、running background count。展开 child 只影响可见详情，不改变 shell authority。
- timeline 同时暴露：raw `windowRowCount`、raw `totalRowCount`、logical `renderUnitCount`；mounted unit 通过单独 turn-unit 属性计数。禁止把 raw row 与 turn unit 数直接比较。
- edit/retry/fork/delete/rename 的入口和 command ACK 必须通过稳定 TID/command probe 验证；主 composer 草稿与行内 edit draft 是两个独立状态。

## Split 所有权

```text
draft / ungrouped split
  owner = paneLayout:v2
       |
       | second pane binds a normal session and promotion succeeds
       v
multi-session workbench group
  owner = workbench-groups:v1
  paneLayout:v2 = single primary (consumed source)
       |
       +-- divider ratio -> group.root
       +-- refresh -> group.root
       `-- close to one pane -> group GC -> ordinary single pane
```

`workspaceIdentity?.trim() || workspacePath` 继续作为 group/session isolation key。该状态只在 renderer-local desktop/普通 Web workbench；手机 `/remote` 的 `web-remote-replayable` 不创建、不恢复、不持久化 group。

## 分页与 cold 边界

provider 在一个 turn 内发送多个 text block：live 可见多个 raw segment。旧数据的 cold transcript 只有一个合并后的 text part；[Assistant 内容块顺序](../../apps/zcode-cli/docs/design/v2/model/assistant-block-order.md) 之后写入的数据每个文字块一个 part，cold 与 live 行数相同。为了同时兼容旧数据，load-older/scroll fixture 仍用多个真实 completed turn 构造历史，确保 live/cold 都有相同 turn-unit 语义。

另保留独立 bug-candidate：raw row tail 若切在巨大单 turn 中间，UI unit key、prepend anchor 和 viewport 不足时的自动 loadOlder 必须有小型单测；不能靠 E2E 手工假滚动掩盖。

## 验收顺序与剪枝

- 接受：上述 14 个现有 formal case，修复既有产品语义或测试 materialization。
- 不新增：Docker admission、mobile replayable E2E、全量 status-panel 视觉叉乘、所有 window manager API 叉乘。
- 不剪枝：edit rerun、rename/delete、split close/ratio、loadOlder、scroll、B08 和 turn navigator 都保留 formal。
- 先跑每个失败组的 unit/focused RED→GREEN，再跑对应严格 single-spec，最后重新跑 29-spec strict batch 与默认 CI-style batch。
- 本轮按用户要求不运行 Docker；desktop batch 只证明 `desktop-continuous`，不宣称手机 `web-remote-replayable` 已覆盖。
- formal CI 必须先执行 conversation admission audit，并以 strict case-local fixture 模式运行；summary 必须逐文件覆盖展开后的全部 spec，不能只检查 `tests.total > 0`，也不能让 legacy replay fallback 替缺失 matcher 假绿。

## Targeted 修复进度

截至 2026-07-11，首轮 14 个失败 spec 已全部用严格 fixture 池单独转绿：

- `background-work`、`compact`、`delete`、`edit`、`fork-edit-branch`、`goal`、`rename`、`sidebar`：run `v4-ui-formals-strict-20260711-032153`，8/8。
- `load-older`：run `v4-load-older-strict-20260711`，1/1；25 turns、75 raw rows、cold tail 60、prepend anchor 均通过。
- `scroll`：run `v4-scroll-strict-20260711`，1/1；14 turns、controlled stream、不拉回与回到底部均通过。
- `stop-queue`：run `v4-stop-queue-strict-after-prewarm-fix-20260711`，3/3（含 B08）。
- `turn-navigator`：run `task6-turnnav-fix-final-20260711`，1/1。
- `split`：run `v4-split-strict-after-owner-fix-20260711`，1/1。
- `split-persist`：run `v4-split-persist-strict-dynamic-owner-20260711`，1/1；同时证明 promoted group 与侧栏普通 split 的动态唯一 owner。

## 总门禁闭环

截至 2026-07-11，两种 desktop non-Docker 全量批次均已通过：

- strict provider pool：run `task6-strict-green-20260711`，29 specs、34/34 tests、0 failed；只加载 `common.json` + 29 个 case-local fixture。
- 默认 CI-style 自动 fixture resolution：首次 33/34，唯一失败为 scroll 只等待 render unit、在最后一个 turn 的 assistant/timeline rows 完整物化前读到 41/42；补成完整 3-row turn barrier 后，single-spec run `v4-scroll-ci-barrier-fix-20260711` 1/1，通过；完整 rerun `task6-ci-style-green-rerun-20260711` 为 29 specs、34/34 tests、0 failed。

review 追加的 SWG10/SWG11 与 formal CI strictness 不回退上述产品合同：group primary 删除必须回 draft，`web-remote-replayable` 必须绕过 group 的恢复/创建/持久化/消费；CI 必须 admission audit + strict case-local + expected spec 文件覆盖校验。它们分别由 UI 定向测试与 CI/config 测试守门，不把 mobile replayable 冒充成本轮 desktop E2E 证据。
