# 帮助配置验证与 E2E 覆盖

> Todo103：本文保留 staging 的既定行为与历史验收记录；历史通过数不计为本次通过。
> 本次整合证据另记在 todo103-staging-integration-ledger.md，未改变 Provider/Selection 边界。

## Feature Summary

Todo103 复验修正：`setApplicationLocale` 是 Main 原生菜单状态，不等同于 Renderer
语言设置。当前正式用例先在隔离配置写入英文并重载，再运行英文 UI 断言；结束恢复
原设置。否则中文系统下会把已有 Help/反馈入口误判为缺失。无需修改产品语言机制。

| 项目        | 决定                                                                |
| ----------- | ------------------------------------------------------------------- |
| 目的 / 模式 | 验证 client/configs 迁移，implementation-handoff                    |
| 层级        | option-source、validation、commit-effect、persistence               |
| 既定语义    | 沿用 settings-community-link-config.md 和本任务用户已确认的迁移规则 |
| 范围外      | 工单提交、Agent/session、owner、continuous/replayable、服务器修改   |

## UI Surface Matrix

| 场景 / 入口                          | 共享实现 / owner                                       | 默认与校验                          | 提交落点                   | 模式差异 / 隔离                      |
| ------------------------------------ | ------------------------------------------------------ | ----------------------------------- | -------------------------- | ------------------------------------ |
| 问号菜单社群                         | WorkspaceHelpMenuButton → platform → desktopHelpConfig | 当前语言远端→内置                   | shell.openExternal         | Desktop / Web 平台分别打开；不改会话 |
| 原生菜单 / 命令面板反馈              | desktopCommandHandlers → helpAppConfig                 | false→内置弹窗；true→远端或内置地址 | OpenFeedbackDialog / shell | Web 平台始终打开地址                 |
| Windows caption / 命令候选社群可见性 | canOpenCommunity                                       | 同语言无远端及默认值则 false        | 只读                       | 不把显示状态当成已打开链接           |
| 问号菜单问题上报                     | helpMenuActions / feedbackStore                        | 不读取反馈开关                      | 内置 Dialog                | 与平台反馈模式保持独立               |
| 浏览器配置读取                       | resolveWebHelpConfig / readHelpConfig                  | envelope、同语言默认值              | fetch + 内存 Map           | Web 省略 platform；无远控 Host 新增  |

## Shared And Divergent Behavior / State Owners

HTTP 和内存缓存规则共用 helpAppConfig；反馈 UI 入口并不共用开关。
远端 API 是配置权威，内置 JSON 是默认值，Map 只保存 1 小时成功响应；不存在持久化写入。

```text
配置状态 → 用户入口 / 平台动作 → 当前 endpoint 请求 → code=0 校验
                                      |
                     内存成功缓存 ←---+---→ 逐字段 / 同语言回退
                                      |
                       外链调用 / 内置弹窗 / 不可用
```

## Feature Relationships / Must-Preserve Invariants

- must-inspect：reader → Desktop/Web，均不能请求旧 CDN，不能缓存失败，不能跨 endpoint 污染。
- should-inspect：菜单语言、实际外链、内置弹窗出现；不能用“外链调用数暂时为零”冒充弹窗成功。
- invariant-only：task、remote attachment、continuous/replayable 不在该请求链路内。
- evidence-only：原 HC-01 使用 net.fetch mock，只证明请求选项，不证明真实 HTTP 传输或磁盘缓存行为。

## Codegraph Evidence / Graph Drift / Graph Delta

当前工具未提供 codegraph 索引查询；按确定的文件 seeds 用 rg 检查直接调用，深度 2。
seeds：helpAppConfig、desktopHelpConfig、desktopCommandHandlers、communityUrl、WorkspaceHelpMenuButton。
图谱尚无帮助配置能力，本次增加已确认的能力 seed，不推断其他业务依赖。
漂移候选：问号菜单目前始终展示社群项，Windows caption 和命令面板才有可见性 gate；
测试明确区分平台可用性与问号菜单，避免声称已验证所有入口隐藏。

## Clarification / Boundary Decisions / Dimensions

用户已确认迁移规则并授权完成验证；不重新询问既定语义。
维度为 zh-CN/en-US、远端全量/部分/失败、同一/不同 endpoint、首次/重复请求、Desktop/Web。
工作区身份、模型、主题不影响纯配置结果，剪枝全量笛卡尔积；桌面以真实入口点击验证代表路径。
TTL 精确到期、请求未完成时切换 endpoint 保留在可控时钟单测，不把 E2E 等待 1 小时作为验证。
本轮仅进行本机验证；浏览器窄屏配置集成不是完整手机远控验收。

## Accepted Cases / Coverage Matrix

| ID    | Setup                                                        | Action                                           | 必须断言                                                         | 证据层               |
| ----- | ------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------- | -------------------- |
| HC-01 | 本地 HTTP fixture 完整中英文配置                             | 真实问号菜单点击社群；调用中英文可用性并再次点击 | 正确语言外链、实际请求路径/参数/次数，重复读取命中内存           | UI + network         |
| HC-02 | 远端只含中文、fixture 提供英文内置默认值                     | 英文平台社群动作                                 | 使用英文默认值；绝不进入中文远端                                 | runtime + filesystem |
| HC-03 | 远端 false、本地 true；另一个 endpoint 远端 true             | 平台反馈动作                                     | false 出现真实内置 Dialog，外链未调用；true 打开远端地址         | UI + runtime         |
| HC-04 | 503 / 业务错误 / 无效 JSON                                   | 平台可用性与社群；恢复同 endpoint 的成功响应     | 默认可用、失败不缓存、恢复后新地址；无值时平台不可用             | HTTP + runtime       |
| HC-05 | Chromium 窄屏加载实际 Web resolver bundle，HTTP fixture 可变 | zh/en、并发、重载浏览器页面                      | 同语言结果、无 platform、请求合并；重载重新请求而不走 HTTP cache | browser + HTTP       |

## E2E Handoff Notes

- 用户在本机 8/8 通过后明确授权转正；正式路径为 `packages/desktop/test/e2e/feedback/help/help-client-config.test.ts`，默认 desktop E2E 收集。
- fixture 使用 case-local JSON；模型请求策略 none，全部帮助请求为 synthetic，注明 syntheticReason。
- 本地 HTTP server 只监听 loopback；每 case 独立 origin，恢复 settings 和临时默认配置文件。
- 现有 e2e:fixture:check / e2e:promote 只实现 conversation/plugins 域，不能直接处理 settings。
  本例使用本地 fixture 合同检查与 WDIO；不迁入 conversation 来绕过域限制。
- 按用户要求停止 Docker 验证，仅采用本机结果；Windows/Linux 实机和手机实机未验证。

## Unresolved Questions / Planning Handoff

产品语义无新增待决；问号菜单无配置时的显示问题记录为既有漂移，不在此次纯迁移验证中修改 UI。
本文件同时承担 impact brief、catalog、matrix、剪枝记录；实际运行证据如下。

## 验证记录（2026-09-04）

- macOS 首轮 8/8 passed：`desktop-e2e-20260904061809303-p54917-66703063e8ddebb5`，包含真实 HTTP 和 390×844 Chromium 浏览器窗口。
- 正式接口按 darwin-arm64、win32-x64、linux-x64、Web 省略 platform 分别请求，全部 HTTP 200 / code 0，均含三个帮助字段。此证据不是 Windows/Linux UI 实机验证。
- 原 settings/manual-review 路径没有被默认 WDIO exclude 覆盖，现已移到现有 auth/config `manual-review/pending`，避免候选用例意外进入默认 suite。
- `e2e:fixture:check` 对新路径明确返回 unsupported domain；不改工具规则、不伪造 provider fixture。自校验确认 manifest 的 8 个 synthetic 场景均有原因，所有文件存在、canonical spec 为 `./test/e2e/feedback/help/help-client-config.test.ts`，provider policy 为 none。

- 迁移到受支持的候选目录后，限定 common provider fixture 重跑 8/8 passed：
  `desktop-e2e-20260904062010268-p58126-9129778db7899df8`。provider capture 的 records 为 0。
- 帮助配置相关单元测试 36/36 passed（shared reader、remote config、Web resolver、desktop commands）。
- `pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、`pnpm lint` 全部通过；
  lint 41 个既有 warning、0 error。

### 重跑正式用例

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/feedback/help/help-client-config.test.ts
```

先完成 typecheck 再构建/运行 Electron，避免二者同时写 out/host。
按用户要求不走 Docker；本轮容器尝试已终止，未计入通过结果。

### 转正记录

2026-09-04 用户明确要求通过后转正。promotion dry run 拒绝 auth/config 路径，
因为脚本只支持 conversation-session；沿用本域既有做法直接迁移到根目录正式路径、
修正 helper import，保留现有 canonical manifest 与 case-local fixture。
不新增 conversation provider fixture，不加入 Docker preset。

转正后本机验证：

- 正式路径默认 replay：8/8 passed，artifact `desktop-e2e-20260904063506750-p72944-12b19ddcc35e5a3d`。
- 正式路径仅 common fixture replay：8/8 passed，artifact `desktop-e2e-20260904063636183-p75423-66532649b7413591`。
- 两轮均未设置 `ZCODE_E2E_MANUAL_REVIEW`，正式 spec 被 desktop WDIO 正常执行。
- `typecheck:e2e`、`pnpm typecheck`、`pnpm lint` 通过（41 个既有 warning，0 error）；格式与 diff 检查通过。
- manifest 校验确认正式路径存在、8 个 synthetic 场景均注明原因、file fixture 存在、provider policy 为 none。

## 可选登录请求头增量验收（2026-11-03）

HC-05 在同一 Chromium 页面依次读取匿名、账号 A、账号 B 和退出状态，断言请求头、同身份去重与缓存隔离。对应 client-config-service.md 的可选登录约定；本次正式 E2E 9/9 通过，证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20261103072354051-p27008-4b1f5847ed2c0020`。

补充隔离运行时：Node/Electron 56 项和 Chromium 默认凭据仓储 5 项检查通过。覆盖公开 HTTP 缓存、匿名/登录 A/登录 B/退出、凭据错误与非法字符、身份缓存隔离、迟到响应、重定向不外发凭据，以及浏览器残缺会话只读。完整包、Windows/Linux、手机实机与生产后台未验收。
