# 04 — 预装工具对话框完整交互（方案 A）

Status: done

## Parent

[01 — 桌面文档工具预装：LibreOffice](01-libreoffice-preinstall.md)

## What to build

把 03 的只读对话框补全为 spec“UI、反馈和执行环境隔离”规定的方案 A，用户可以完整控制预装。

- “自动预装”开关：命令经 Main 转发给预装工具进程，由该进程写入本机设置；重启后保持。
  打开开关时，如果资源未就绪，立即发起一次准备。关闭开关不取消当前准备，也不删除已安装资源。
- 卡片按钮：未安装时“下载”，准备中时“取消下载”，失败时“重试”。手动操作不改变开关。
  重复点击，或启动自动准备与手动请求重叠时，只进行一次实际准备。
- 取消与完成交错时以发布点为准：发布前取消则清理临时目录并回到未安装；发布后到达的取消被忽略。
  旧操作的迟到进度或错误不覆盖新操作。
- 各状态的状态标签、信息行和按钮按 spec 的状态表显示；七种失败原因按 spec 的文案表显示。
  本票只需要接通失败显示，具体故障的识别在 05。
- 打开远端工作区时显示“这里管理的是本机”的提示。
- 中英文文案进入国际化资源；适配深浅主题、键盘操作和小桌面窗口。不弹出任何提示。

## Acceptance criteria

- [x] LOP-03、04、06：开关的持久化和语义正确；手动下载后开关保持原值；下载中关闭开关不影响当前操作。
- [x] LOP-07：下载中取消，不发布半成品，卡片回到未安装；随后重试会重新下载，偏好不变。
- [x] LOP-09：重复点击下载或重试，与启动自动准备重叠时，只进行一次实际准备。
- [x] LOP-10：取消后立即重试，旧请求迟到的进度、错误或完成消息不覆盖新操作。
- [x] LOP-14、15：入口与对话框符合方案 A；中英文、深浅主题、小窗口和键盘操作都清晰可用。
- [x] LOP-24：远端工作区显示本机提示，不向远端部署。

## Blocked by

- [03 — 预装工具进程与后台准备闭环](03-preinstall-process-tracer.md)

## 验证

全部在本机 macOS arm64 上完成。

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 桌面 E2E 覆盖上述场景；LOP-10 用受控服务延迟旧请求的响应来复现迟到消息。
  新用例按 [E2E 用例生命周期](../../../.agents/skills/e2e-case-lifecycle/SKILL.md)转正。
- 视觉验证：中英文 × 深浅主题，以及小窗口下各状态的截图，对照 DESIGN.md 和原型方案 A。

## Comments

### 2026-10-28 — 完成

- 实现 commit：`ce0daff30f3`。基于集成分支 `52f68a5f029`，提交前已再次合并集成分支。
- 已接入自动预装持久化、手动下载、取消、重试和远端工作区本机提示。偏好仍由预装进程通过现有设置写队列保存；
  Main 只转发严格校验后的命令。UI 只使用 owner 推送的状态，不用迟到的命令回执覆盖新操作。
- 先澄清 spec 01 再实现发布与取消的顺序：最终取消检查和发布准入之间没有异步间隔，已准入的原子写入先结算；
  成功记录不因重叠取消撤销，写入失败保留真实失败并清理。取消收尾后才释放旧操作并推送未安装，紧邻的明确重试等待旧清理后竞争同一新操作。
- 检查通过：根 `pnpm typecheck`、`pnpm lint`（172 项既有 warning，0 error）、`pnpm architecture:check --changed`（0 violation）；
  E2E 类型检查、两个候选 fixture check、改动文件格式与 diff 检查；受影响工程检查 22/22。
- macOS arm64、App 3.16.3 控制流程候选 1/1 PASS：`desktop-e2e-20261027182451655-p99663-0416606e7fcca175`。
  观察到 7 次实际下载、4 次运行检查和 1 次旧连接迟到写入尝试；验证关闭开关不取消、关闭后重启不自动下载、
  手动下载/重试保持偏好、重复请求共用操作、取消后紧邻重试、检查阶段取消、发布后取消不撤销、发布失败无半成品且可重试。
  25 张中英文 × Zai 深浅主题及小窗口截图覆盖未安装、下载、检查、失败、就绪；另有发布失败截图。
  小窗口使用应用真实支持的 760 × 640 内容尺寸。首次请求 620 高度被 Electron 的 640 最小高度约束拒绝，修正测试尺寸后通过，未改变产品尺寸规则。
- 旧只读界面的 red 对照：`desktop-e2e-20261027180317200-p88520-dd00e93643413789`，在自动预装开关不存在时失败。
  03 tracer 回归 1/1 PASS：`desktop-e2e-20261027182721308-p1174-e141a57d6698295d`，自动准备、复用、工作区切换和崩溃恢复保持成立。
- LOP-24 专项 1/1 PASS：`local-docker-20261027183854-891ad8`。macOS 桌面通过现有 harness 连接隔离的 Linux arm64 SSH 目标；
  对话框显示本机提示，取消清理本机 staging 且不发布记录，远端受管目录在操作前后均不存在。runner 已删除本次隔离容器。
  自然启动的远端 Agent 未被观察到（证据列表为空），因此本次不证明 02 的远端 Agent 环境变量不注入。
- 待人工审核的新增候选：`conversation-session/manual-review/pending/conversation-session-preinstalled-tools-controls.test.ts`、
  `conversation-session/manual-review/pending/conversation-session-preinstalled-tools-remote-context.test.ts`。未转正、未计入正式覆盖。
  工件为对应 `.e2e-artifacts/<runId>/`，均已另行保存在本地协调目录，清理 worktree 不会丢失。
- 未验证：真实 LibreOffice、真实 CDN、Windows/macOS x64/Linux 桌面与 WSL/Docker 连接类型；
  小包截图的体积仅来自测试清单，不代表发行包体积。Linux SSH 目标只用于验证 macOS 桌面上下文，不构成 Linux LibreOffice 验收。
