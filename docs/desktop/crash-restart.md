# 桌面崩溃后的手动重启

## 范围与决定

用户确认采用轻量恢复：主业务窗口 renderer 进程崩溃，或根级 React 错误页出现时，提供“重启应用”。不增加守护进程，不承诺恢复未保存内容或继续正在执行的任务。主进程原生崩溃、被系统杀死、机器重启不在范围内。

改动属于 presentation / commit-effect / recovery。主进程是重启动作和原生弹窗的唯一 owner。现有普通退出、菜单重启、更新安装、局部错误边界和内置网页恢复保持原契约。

## 入口与影响

| 场景                     | 入口与显示 owner   | 校验                                                          | 提交动作 / 权威                                           | 模式与隔离                                             |
| ------------------------ | ------------------ | ------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| 主窗口 renderer 异常终止 | Main 原生对话框    | 排除正常退出、零退出码 killed、应用退出中；全应用最多一个弹窗 | Main `restartAppAfterCrash`                               | 只监听业务窗口，不监听网页 guest、资源管理器、录屏窗口 |
| React 根级异常           | `AppErrorBoundary` | 只有注入 `onRestart` 的宿主显示按钮                           | Desktop platform → 既有桌面命令 IPC → `RestartAfterCrash` | 不依赖 Root 内的 Provider；全部 Desktop 根边界注入     |
| Web / 手机错误页         | 同一个根边界       | 未注入重启能力                                                | 现有重试 / 刷新页面                                       | 不可重启所连接的桌面 Host                              |

共享重启命令只执行一次 `app.relaunch()`，随后 `app.exit(0)`。它不等待 renderer、Host 清理屏障或退出确认。旧进程退出后由 Electron 启动新实例，使用原启动参数和现有冷启动恢复。异常退出可能丢失尚未落盘内容；提示明确说明。不删除配置、凭据或历史，不增加恢复状态文件。

```text
主窗口 render-process-gone → Main 排除退出中 / 合并弹窗 → 重启 / 稍后
React 根边界 → 用户点重启 → desktopPlatform → 桌面命令 IPC ─┤
                                                        ↓
                           Main 重启去重 → relaunch → exit → 新实例冷启动
Web / 手机根边界 → 原有页面刷新
```

原生弹窗显示时使用当前界面语言；系统负责主题和平台外观。弹窗等待期间窗口被关闭或应用开始退出，则旧响应不再触发重启。多个崩溃不会排队弹窗或自动重启。根错误页按钮沿用现有 Button、主题 token 和独立语言解析。

## 影响检查

- must-inspect：`main/index.ts:createWindowInstance`、`desktopCommandHandlers.ts`、`desktopCommandIpc.ts`、`shared/src/platform.ts`、`renderer/src/main.tsx`、`ui/src/ErrorBoundary.tsx`。扫描深度为入口 → 主进程提交两层；本工作区没有 codegraph 索引，使用源码确认。
- should-inspect：退出清理与 `before-quit`，确认紧急重启不被坏掉的 renderer 阻塞；原有 crash 留档继续工作。
- invariant-only：guest 恢复、Web/手机刷新、普通退出与更新；不改变 task/session owner、workspace identity 或 continuous/replayable 协议。
- evidence-only：以下真实 Electron 与浏览器验收。没有新增 App 业务单测。
- 图谱此前没有此能力；新增轻量崩溃恢复入口和 Main owner。无未决产品问题。

## 用例与覆盖矩阵

| ID   | 准备 / 动作                                          | 必须断言                                                             | 状态             |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------- | ---------------- |
| CR01 | 隔离 Electron 主窗口实际 `forcefullyCrashRenderer()` | 崩溃日志、一个原生恢复弹窗、点击重启进入 relaunch → exit；取消不退出 | covered（D + N） |
| CR02 | 正常退出、零退出码 killed、辅助窗口实际崩溃          | 不弹应用重启框                                                       | covered（D）     |
| CR03 | 实际 React 子树抛错，桌面根边界显示                  | 原有重试/刷新可见；重启按钮调用注入能力；中英日俄韩、深浅主题可访问  | covered（B）     |
| CR04 | Web/手机宽度的同一错误页                             | 无重启桌面按钮；刷新仍重新加载当前页面                               | covered（B）     |
| CR05 | 桌面根边界进入错误页，点击按钮                       | 真实 preload / IPC 到 Main；跳过普通退出屏障                         | covered（D）     |
| CR06 | 隔离 Electron 重启命令真实执行                       | 旧 PID 退出，新 PID 加载；只启动一次                                 | covered（N）     |

维度只保留故障入口、退出状态、确认动作、平台能力、语言和主题。主进程已死亡、运行任务无损续接、远控自动恢复及全量平台矩阵剪枝：分别需要守护进程或独立业务恢复设计，不属于已确认需求。

候选 E2E 保留 `ui-shell/recovery/manual-review/pending/`，浏览器验收保留 UI browser pending；无需模型请求或 Provider fixture。未人工 review，不转正或加入 Docker preset。运行后在本表更新证据；平台未实测不计通过。

## 验证记录

- D：`packages/desktop/.e2e-artifacts/desktop-e2e-20261112065919390-p36483-4c8fad1c74682bfb`，候选桌面 E2E 1/1 通过。真实主窗口和辅助窗口进程崩溃；原生弹窗边界自动选择“稍后”。错误页实际按钮经 preload / IPC 到达 Main，截断 `relaunch/exit`，断言调用顺序及重复点击只执行一次；不将此截断冒充完整 App 重启。
- B：`packages/desktop/.e2e-artifacts/crash-restart-browser`，浏览器验收 12/12 通过；真实 React 子组件抛错，五种语言、深浅主题及手机宽度 Web 刷新。截图已检查。
- N：`packages/desktop/.e2e-artifacts/crash-relaunch-native/result.json`。从当前源文件提取恢复函数运行于隔离 Electron 入口，真实 renderer 崩溃后自动选择重启；旧 PID 85585 退出，新 PID 85617 完成窗口加载。特意注册拦截普通退出的 handler，紧急重启仍完成。此探针验证 Electron 进程替换，不是完整发行包恢复验收。
- 实测 Electron 44.7.0 在本机把 `forcefullyCrashRenderer()` 报为 `killed / exitCode=2`，因此仅忽略零退出码 killed；非零退出码仍提供恢复。
- 根类型检查、桌面 E2E 类型检查、Lint、架构检查通过。Lint 保留 671 条既有警告，本次改动文件无诊断。受影响工程检查 51 个文件通过，359 条通过、1 条跳过；格式和 diff 检查通过。
- 首轮默认 capture 缺模型服务配置，未执行测试；改为 `E2E_PROVIDER_HTTP_MODE=replay` 后无需模型请求。之后定位到 ChromeDriver 在 renderer 已 reload 后仍保留 crashed target，验收后半段改走 Main 调试通道操作真实 DOM；产品不增加测试分支。
- 本轮为 macOS Electron 开发构建和浏览器验收。Windows/Linux 桌面、手机实机、发行安装包、真实系统对话框按钮自动点击及运行中任务无损恢复未验证；guest 未单独注入，本次只给业务窗口注册监听。

复跑候选用例：

```sh
ZCODE_E2E_MANUAL_REVIEW=1 E2E_PROVIDER_HTTP_MODE=replay \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/ui-shell/recovery/manual-review/pending/desktop-crash-restart.test.ts'
node --test packages/ui/test/browser/manual-review/pending/crash-restart.test.mjs
```
