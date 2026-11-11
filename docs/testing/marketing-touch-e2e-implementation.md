# Marketing Touch E2E 补齐实施规范

正式回放维护（2026-10-15）：隔离 fixture 从已完成职业引导的账号启动；全局触达只等待应用壳，不要求固定项目已激活。MTA-05 按主 action 的稳定 test id 点击；Start Plan 导航会将按钮文案改为本地化的 View plan，不再硬编码 fixture 的 Run action；目标应选中独立的 Start Plan 节点。营销升级 fixture 在领取前保留可查询的个人项目和短期 Token，订阅列表仍为空；否则全局套餐入口检查会把凭据未知当成未就绪，四条升级路径都无法开始。其它领取 fixture 的前置状态保持原合同。

### 任务完成触发刷新（2026-09-18）

MTC-TASK-COMPLETE 对应 [客户端约定](../marketing-touch-client.md#任务完成后刷新2026-09-18)。
本轮待正式回放 spec：`packages/desktop/test/e2e/ui-shell/marketing/marketing-touch-task-completion.test.ts`。
用例通过真实 composer 发起任务，由 case-local synthetic 延迟文本 fixture 返回成功，
在运行中通过已有 online 入口重置轮询计时，再断言 15 秒内出现新的营销 HTTP 请求，
排除 30 秒轮询假阳性。2026-10-19 人工复核后补齐标题 fixture，但正式回放尚未执行，阶段提交保留 pending；不代表真实服务端投放或手机实机已验证。
根据已捕获的标题 Missing Fixture，补齐本例非流式标题响应及 manifest；主请求与完成刷新断言不变。

单测覆盖：历史/重复完成不触发、失败/中断不触发、再次运行完成、同批完成合并、
重连基线、RPC readiness、远程 workspaceIdentity/endpoint 传递及卸载引用释放。
桌面/Web Provider 均验证完成刷新入口复用 poller 的在途合并；隐藏行为沿用 poller 回归。

验证：39 项单测通过；macOS App E2E `desktop-e2e-20260918-092233-578` 1/1 通过，
runner exit 0。首次执行被隔离账号首次使用引导阻挡，候选用例补公开 Esc 关闭后通过。
typecheck、desktop typecheck:e2e、architecture、格式检查通过；lint 55 warnings / 0 errors。
桌面/Web Provider 合并及远程身份为单测证据；手机远控端到端、Windows/Linux 未验证。

### Banner hover 消息回归（2026-09-15）

扩展既有 MTC-BUNDLE：真实鼠标移入/移出 App Banner，在隔离 iframe 中观测宿主 postMessage 的 hover true/false；保持 pointer-events:none、原缓存与 confirm/cancel 各一次断言。macOS Electron `desktop-e2e-20260915-125754-599` 1/1 通过（6.7 秒，runner exit 0）。14 项 UI 单测通过，覆盖 ready、pending、touch、blur、hidden、动态 reduced-motion。外部资源工作区 11 项单测及三包浏览器回归通过（含蹬蹬卡实际 CSS transform）。App E2E 使用隔离 ZIP fixture 验证协议，并非线上投放 ZIP；未验证 Windows/Linux/手机实机或真实服务端替换。没有新增业务 action 或扩大远控边界。

状态：2026-09-12 用户已授权继续实现；未完成项不得用审计完成替代。

### 转正决定（2026-09-12）

推送前全量单测发现 delivery 原有截图路径不符合 E2E runtime 路径门禁。四处截图统一写入 runner 提供的 `ZCODE_E2E_ARTIFACT_DIR`，缺失时明确失败，不写系统临时目录，也不改业务断言；原路径门禁保留作为回归测试。

用户将门槛调整为 90%（排除 Lottie），并明确要求转正。已有同轮 60 项通过及 Renderer 90.07% 证据；该数字不代表全运行域覆盖率。三个 marketing-touch spec 迁至 `packages/desktop/test/e2e/ui-shell/` 正式目录，保留既有隔离 HTTP fixture 和全部断言。正式路径下不依赖 MANUAL_REVIEW 开关，本机 Electron 重新验证，不使用 Docker、不 push。尚未覆盖的平台和历史矩阵剩余边界继续保留，不随转正改为已覆盖。

标准 promote 工具 dry run 拒绝 ui-shell 路径（仅支持 conversation-session）；因此在原领域迁移并修正 helper 相对路径，不强行迁入 conversation-session，不生成无关 DeepSeek 回放 fixture。

转正验证完成：`desktop-e2e-20260912-042005-517` 在正式路径、未设置 MANUAL_REVIEW 的本机 Electron 运行 **60/60 通过，runner exit 0**。anonymous 2 项（44.6 秒）、delivery 57 项（4 分 28.3 秒）、entitlement 1 项（3.9 秒），日志 `/tmp/marketing-formal-e2e.log`。相关单测 31/31，typecheck、desktop typecheck:e2e、lint（45 既有 warnings / 0 errors）、architecture（0 violations）通过。三个 spec 仅重命名及 helper 引用调整，全部断言保留；默认 `test/e2e/**/*.test.ts` 包含正式路径。产品代码未改，90.07% 为先前覆盖轮证据，本次未重采覆盖。未运行 Docker，未 push。原 Goal 后端仍保留旧 95% 目标且不允许替换未完成目标；该面板状态不能视为已同步本次用户变更。

### 最新范围决定：排除 Lottie（2026-09-12）

用户明确要求“忽略 lottie”。本次 95% 验收不覆盖 Lottie 专属实现，不删除产品代码、不新增营销 Lottie 协议；此前等待 Lottie 扩展授权的范围阻碍已解除。下方历史完整分母与 93.71% 上限只保留为旧口径记录，不再作为当前验收上限。

排除范围为 `CloudDialogMediaHero.tsx` 的 `CloudLottie` / `LottieResource` 两个函数，以及 `cloudLottieRuntime.ts`；当前共 84 个可执行差异行。保留同文件 image/video、公共环境与 Hero 分发逻辑，不能整文件排除共享代码。排除项必须单列，原覆盖报告不改写；后续审计工具需机械应用同一范围，不把手工重算当成完整覆盖门禁。

基于同轮 `desktop-e2e-20260912-035844-296` 重算：统一源码清单剩余 **1252 行（1336−84）**；Renderer 已映射差异行剩余 **816 行（900−84）**，命中仍为 **735 行，即 90.07%**。该 Renderer 口径至少还需命中 41 行才能达到 95%；这不是跨域整体覆盖率。整体可信命中归一化、剩余 accepted 用例及完整门禁仍需完成；仍不转正、不 push。

### 统一分母验证记录

统一源码清单采用固定 TypeScript ESNext/JSX-preserve 转译（不 tree-shake）后 Istanbul 插桩，再通过编译 source map 回到原文件的 statement 起始行。所有运行域共用这一清单，只计 Git 差异中的行；import/纯类型/空白不计，enum 等先转译为运行时代码后保留。解析失败或生成语句无原始映射必须显式列 unknown，不能静默缩分母。此阶段仅建立 canonicalExecutableLines，不将 Node raw counters 自动投影为可信命中，也不改变历史 Renderer 900 行口径；最终整体覆盖率仍待命中可信度及全部范围核实。

实跑 `/tmp/marketing-canonical-audit.json`（固定 merge-base 至 `a27a0446ae`，产品代码与当前一致）得到 **41 个文件、1336 个可执行差异行**，解析失败和 unmappedStatements 均为 0。Lottie Hero 48 行 + runtime 36 行 = 84 行；当前 CloudContentDialog 唯一生产使用处是 MarketingDialogs，营销 visual body 无 Lottie 入口。因此在此完整清单下，即使其余行全覆盖，上限也是 `(1336 - 84) / 1336 = 93.71%`。这不同于先前仅 Renderer 的上限，现已具备全清单的上限证据。已再次请求用户决定是否授权补齐 Lottie 协议与真实入口；未授权前不扩大协议、不剔除分母，其他 accepted 场景继续推进。

4 项新清单测试（纯类型、enum/namespace、JSX/未调用函数、非法源码）与既有 8 项诊断测试均通过；typecheck、desktop typecheck:e2e、lint（45 既有警告/0 错误）、architecture、diff check 通过。只修改审计工具与固定依赖/文档，未重跑或合并 E2E counters，未宣称实际整体覆盖率已计算。

Main 原始 V8 转换计数存在“未生成源码行计为 1”的实例：同轮 source map 中 `contentBundleCache.ts` 仅有 1–14、24–26 行映射，报告却将 50–54 行记为 1，fnMap 为空。诊断工具补充按运行域的构建 source map 交叉检查：读取当前 out 的 map 前，必须逐个匹配本轮 build-source-evidence 的 SHA；缺失、变化或非 fresh-stable 只标 unverified，不能用当前产物追认旧报告。报告保留原计数，另列 positiveLinesWithoutGeneratedMapping；这些是可疑计数而不是新的覆盖率分母，不删除源代码范围、不产生整体百分比。

验证 `desktop-e2e-20260912-032342-498` 的原报告：`/tmp/marketing-generated-map-audit.json` 标出 Main 759、Host 112 个差异正计数行没有对应生成映射，其中 `contentBundleCache.ts` 的 Main map 哈希匹配，原计数缺乏对应生成代码证据。这些含空行/类型等，不能全部记作未覆盖可执行行。本批 8 项诊断测试通过，typecheck、desktop typecheck:e2e、lint（45 既有警告/0 错误）、architecture 通过；仅诊断工具/依赖/文档变更，未重跑 App、未改原覆盖报告，整体仍为 null。trace-mapping 固定使用现有锁文件版本 0.3.31；只增加根依赖声明，不升级其他依赖。

直接用 `istanbul-lib-instrument` 的 TypeScript/JSX parser 解析原始源码，能排除 import、interface、type，但实验确认不会为运行时 `enum` 生成 statement。因此不能直接将这个结果用作所有运行域的统一可执行行分母。该候选方案未接入统计，不改变既有覆盖报告；后续需验证编译转换及 source map，未识别项保留 unknown。

合并执行当前三个 pending spec，并开启 `ZCODE_E2E_SOURCE_EVIDENCE=1`，核验同轮结果与源码指纹；历史分批通过不等价于同轮全量通过。

### 第十一批：同轮 48 项与覆盖报告恢复

`desktop-e2e-20260912-025655-416`：delivery 45、entitlement 1、anonymous 2，共 **48/48 通过**，三个 spec 用时 6 分 59 秒。日志 `/tmp/marketing-full-source-e2e.log`。构建清单 fresh-stable，源码构建前后无变化。

原 runner 在 onComplete 生成 Node 覆盖报告时遇到 ENOSPC，**退出 1**，不能记为全链路绿色。无损压缩本任务已结束的旧覆盖 JSON 后，复用当前轮原始数据调用原 Node collector 的 finalize，恢复命令退出 0；`/tmp/marketing-full-source-recovery.log` 中 Main/Host/CLI complete 均为 true，missingRawProcessCount 与 baselineFailureCount 均为 0。没有重跑或改写用例结果，也没有跨运行合并 counters。

恢复后的 `/tmp/marketing-full-source-audit.json`：Renderer 差异映射行 **721/900 = 80.11%**、函数 178/222、分支 609/885；Renderer/Host/Main 源码身份匹配，CLI 未验证。Node 物理行映射与运行域异常仍存在，整体百分比保持 null。用例通过、采集恢复、代码覆盖率达标是三个不同结论，本轮仍未达到 95% Goal。审计工具 7/7 回归通过；本批仅文档变更，不改产品及测试代码，pending 状态不变、不 push。

### 第十二批：真实 iframe 非法消息

新增 MTE-11 两个独立用例：错误 instanceId 的 ready 走原超时及图片 fallback；正常 ready iframe 发送 null、错误 instance/channel、非法 error/action/resize 字段、未知 type 共七类消息后仍 ready，无错误占位/自动上报，用户关闭只报一次 cancel。ZIP 内标记确认错误 ready 确实发出；非法消息由 WebDriver 切入真实 sandbox iframe 后 postMessage，未直接调用校验函数。

`desktop-e2e-20260912-031121-888` 新构建 **2/2 通过**（19.7 秒），runner 退出 0，源码证据 fresh-stable；日志 `/tmp/marketing-instance-e2e-final.log`。首轮 `030940-602` 因使用底层 switchToFrame 参数格式不符而在准备阶段失败，改为现有 switchFrame 用法后重跑，不计首轮为产品缺陷或通过证据。13 项 fixture 单测、typecheck、desktop typecheck:e2e、lint（45 既有警告/0 错误）、architecture、diff check 通过。仅测试和 fixture 改动，不改产品。当前共 50 个独立用例有通过记录，本轮只跑新增两项，不宣称 50 项同轮通过；不跨轮合并覆盖计数，95% Goal 仍未完成。

### 第十三批：Popup 领取失败恢复

MTE-12 的知道了/Esc/遮罩三个独立用例，均以现有 HTTP fixture 下发含 claim 按钮的 Popup。返回 `<b>今日额度已领完</b>` 与换行文案后，验证纯文本、msg 忽略、原 Popup 隐藏；关闭提示后恢复原 campaign，按钮可点击、claim HTTP 仍为 1、events 为空；用户随后关闭原 Popup 才报 cancel 一次，claim 不增加。未 mock Controller 或组件回调。

`desktop-e2e-20260912-031447-923` **3/3 通过**（24.5 秒），runner 退出 0，源码清单 fresh-stable；日志 `/tmp/marketing-popup-failure-e2e.log`。typecheck、desktop typecheck:e2e、lint（45 既有警告/0 错误）、architecture 与 diff check 通过。本批仅测试及文档变更，未发现需要修改的产品缺陷。累计 53 个独立用例有通过记录，本轮仅新增三项，不宣称全量同轮或整体 95%；全部继续 pending，未 push。

### 第十四批：复制超时与迟到成功

MTE-13 新增两项，覆盖超时后 Popup 保持打开/已关闭两个分支。浏览器剪贴板平台 Promise 挂起且计数一次，pending 时点击 X 不关闭、不上报；等待真实 10 秒能力超时，错误显示且按钮恢复；旧 Promise 兑现后不显示成功、不补 confirm、不复活 Popup。最终仅有用户关闭的 cancel 一次。finally 释放 Promise 并恢复浏览器平台方法。

`desktop-e2e-20260912-031836-096` **2/2 通过**（35.9 秒），runner 退出 0；日志 `/tmp/marketing-copy-timeout-e2e.log`。typecheck、desktop typecheck:e2e、lint（45 既有警告/0 错误）、architecture、diff check 通过。仅测试及文档改动，未改变产品超时或关闭语义。当前累计 55 个独立用例有通过记录，本轮只跑新增两项，不跨轮合并计数，不代表 95% 已达成；继续 pending，不 push。

### 第十五批：资源准备的迟到结果

MTE-06 新增真实 Popup 关闭与在途 Banner ZIP 的竞态用例：HTTP 资源 gate 挂起 ZIP，关闭 Popup 后才释放；下一 GET 到达作为旧准备收口的边界，确认旧 Banner 不出现、仅关闭 Popup 的 cancel；释放下一 GET 后 Banner iframe ready，确认同活动新下发仍有效。只新增隔离 HTTP gate，产品不变；reset/stop 释放等待，finally 释放资源和 GET，不修改 ZIP 内容。fixture 主文件保持 398 行。

`desktop-e2e-20260912-032342-498` **1/1 通过**（9.5 秒），runner 退出 0，源码清单 fresh-stable；日志 `/tmp/marketing-resource-stale-e2e.log`。14 项 fixture 单测验证新增挂起/reset 与原有协议；typecheck、desktop typecheck:e2e、lint（45 既有警告/0 错误）、architecture、diff check 通过。累计 56 个独立用例有通过记录，本轮仅新增一项，不宣称全量同轮或整体 95%；保持 pending，未 push。

### 第十六批：自定义 provider 导航

MTE-02 经真实 Custom 模板创建空 provider，读取节点的 providerId，先导航外观再通过营销动作定位回该自定义 provider；确认目标选中、HTTP confirm、持久连接快照和工作区当前模型均不改变。finally 导航回该配置，打开详情「更多」菜单并选择删除、确认，节点消失；不写真实 key、不调用模型服务、不直接修改配置文件。

`desktop-e2e-20260912-033816-286` **1/1 通过**（11.2 秒），runner 退出 0；日志 `/tmp/marketing-custom-provider-e2e.log`。初次类型检查发现 DOM 属性可能为空，补明确异常检查后 typecheck、desktop typecheck:e2e 通过，lint（45 既有警告/0 错误）、architecture、diff check 通过。仅新增测试及文档，没有新增产品修复。累计 57 个独立用例有通过记录，本轮只跑新增一项，不代表全量同轮或 95% 达标；全部 pending，未 push。

### 第十七批：视频减少动效

扩展已有 MTC-RICH：使用当前 Renderer 的 Puppeteer Chromium 媒体模拟，验证 reduce 时 video.paused=true/autoplay=false，no-preference 时恢复播放；两次切换前后 WebDriver 元素 ID 相同，HTTP events 不变。finally 清空模拟，继续原复制动作上报验证。没有替换 matchMedia/播放方法，也没有修改系统偏好。

`desktop-e2e-20260912-034307-178` **1/1 通过**（12.7 秒），runner 退出 0；日志 `/tmp/marketing-motion-e2e.log`。typecheck、desktop typecheck:e2e、lint（45 既有警告/0 错误）、architecture、diff check 通过。只扩展既有用例，独立用例总数仍为 57，不声称覆盖 Hero bundle 动态 reduced-motion 或手机实机；95% Goal 与 Lottie 范围决定仍未完成。保持 pending，未 push。

Webview 回放必须使用本轮 mock 地址构建：邀请页与升级页的 origin 是 Vite 编译期配置。跨 run 复用 `out` 会继续请求旧 mock 地址，不能将这类超时计为产品失败；这些场景回放不使用 `ZCODE_E2E_SKIP_BUILD=1`。

## 60 项同轮复验（2026-09-12）

`desktop-e2e-20260912-035844-296`：本机 macOS Electron，anonymous 2、delivery 57、entitlement 1，**60/60 同轮通过**；各 spec 分别 52.5 秒、8 分 11.1 秒、9 秒。日志 `/tmp/marketing-full-60-coverage-e2e.log`，结果账本 `test-results.ndjson`。启用覆盖率和源码证据，构建指纹 fresh-stable。此前漏覆盖开关的启动已中止，不计为验收。

原 runner 在 onComplete 的 CLI HTML 报告生成遇到 ENOSPC，退出 1，不能视为全链路绿色。压缩旧报告后恢复：第一次因原始 JSON 已压缩而完整性检查失败，第二次解压后仍因空间不足失败；继续释放旧派生页面空间后，第三次使用原 collector finalize 成功（`/tmp/marketing-full-60-recovery-3.log`，exit 0）。Main/Host/CLI complete 全为 true，missingRawProcessCount、baselineFailureCount 全为 0；原始文件数分别 127/126/220。未跨轮合并 counters，保留原 runner 失败事实。

恢复后审计 `/tmp/marketing-full-60-audit.json`：固定 staging merge-base 至 `c1cd829aeb`，Renderer 差异行 **735/900 = 81.67%**，函数 184/222、分支 634/885。Renderer/Host/Main 源码身份匹配，CLI 身份仍未验证；Node 物理行映射不能当成统一可执行覆盖证据，overallCoverage 仍为 null。95% 未达成，仍有 accepted 场景和跨域口径待补，故不转正、不 push。

磁盘处理仅涉及本任务生成报告：多数旧 HTML/JSON 无损 gzip；删除了 `025655-416`、`010639-844`、`013813-308` 三轮的 `coverage/ui-renderer-html` 派生页面（约 112 MB），相应 coverage-final.json.gz 与底层数据保留，可重新生成。不删除源码、ZIP 资源包或用户配置。

## Feature Summary / Impact Brief

沿用 [审计](marketing-touch-e2e-audit.md) 的 UI Surface Matrix、共享/差异行为、关系分级、状态 owner、提交点、不变量及 codegraph 限制。模式由 impact-only 转为 planning / implementation-handoff；范围是本分支相对 staging 的营销业务、必要的 provider 迁移修复、测试与覆盖率工具，不扩展远端动作。代码图工具当前不可用，使用审计确认的调用路径与当前源码复核。

## Clarification Log / Boundary Decisions

| 决定                     | 状态                 | 范围                                                                                                   |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------ |
| 修复现有失败、补齐 P0/P1 | accepted             | 用户明确要求 Goal 继续完成；包括必要产品缺陷，不只改断言                                               |
| 覆盖率                   | accepted             | 用户调整为 90%，排除 Lottie；当前 Renderer 90.07%，不冒充跨域整体结果；函数/分支单列，不以单测补数     |
| 动作能力                 | accepted             | 保留 close/open_url/claim/navigate/copy_text；不创建任务、不切模型、不自动安装/支付                    |
| 旧 API 迁移              | bug-candidate → 修复 | 使用 providerSettingsService.refresh 与当前 providerId/连接结构；不恢复退役服务                        |
| 测试生命周期             | accepted             | case-local 场景与清理；用户授权达到目标且全部通过后转正，只用本机 Electron 验证，不用 Docker、不 push  |
| 第三方/平台              | pruned combinations  | 官方版本安全校验使用确定性回调替身；真实购买/生产资格不执行。macOS 运行不能替代 Windows/Linux/手机实机 |

## Domain Scope / Concept Map / State Owners

营销 Controller 唯一拥有展示、pending 和操作快照；Marketing Service 拥有进程序号/凭据校验；服务端拥有投放与领取事实；原 providerSettingsService 拥有 provider 刷新；BundleCache 拥有资源与 lease；原设置/市场/购买组件拥有目标接管事实。测试 fixture 只拥有隔离服务响应/请求账本，不直接改 Controller 状态。

## Dimensions / High-Risk Cross-Products

| 维度   | 等价类                                     | 风险组合                                |
| ------ | ------------------------------------------ | --------------------------------------- |
| 资源位 | Banner / Popup / success_popup             | 关闭 × 上报；结果 × 新独立弹窗          |
| 动作   | close / copy / navigate / claim / open_url | 在途 × 双击/账号变化/迟到响应           |
| 网络   | 正常/空/失败/超时/慢返回                   | poll × 动作收口；report × 凭据变化      |
| 媒体   | image / video / bundle                     | ready/error/超时 × fallback/无 fallback |
| 导航   | settings/marketplace/upgrade               | 目标加载中/缺失/已激活 × 无副作用       |
| UI     | light/dark、中英、窄屏/桌面、键盘          | 字体样式/裁切/焦点 × 文案长短           |

```text
case reset -> 隔离 HTTP 场景 -> 真实 App GET/资源/RPC
                                  -> 用户动作 -> UI 与 ledger/持久设置断言
case finally -> 撤下场景/释放挂起响应 -> 关闭残留 modal -> 回工作区

claim success -> 并行 entitlement snapshot + providerSettingsService.refresh
                  -> 任一刷新失败仅记录，不逆转成功、不切用户连接
```

## Candidate Combinations / Accepted Cases

以下均为现有契约的 accepted 场景，具体实现状态在验证记录中更新，不能据此宣称已覆盖。

| ID     | Setup                                               | Action                   | Assertions                                                   | 证据                 |
| ------ | --------------------------------------------------- | ------------------------ | ------------------------------------------------------------ | -------------------- |
| MTE-01 | 任意前例失败/残留 modal                             | reset 场景并独立执行     | 与组合执行一致；无旧投放/账本污染                            | App/HTTP             |
| MTE-02 | 当前 provider family/account/custom 与有效连接快照  | navigate 指定 provider   | 选中目标；连接/模型/任务不改变；缺失明确失败                 | App/落盘配置         |
| MTE-03 | claim 成功；刷新正常/拒绝                           | 点击领取                 | 当前 provider 刷新真实调用，失败仍成功；不改连接             | App/RPC/服务回归     |
| MTE-04 | 独立/结果 Popup                                     | X/Esc/遮罩/内容 close    | 独立 cancel 一次；结果不重报；焦点可用                       | App/ledger           |
| MTE-05 | anonymous/登录与安全校验正常/取消/失败              | 连点领取                 | 单次 claim，取消恢复，无自动重试                             | App/HTTP             |
| MTE-06 | 同 ID 下发、慢 GET/资源、pending 动作               | 关闭/成功后旧结果到达    | 旧内容不复活；新下发可再展示与上报                           | App/HTTP             |
| MTE-07 | 正常/失败/隐藏、identity/locale 变化                | poll 与事件刷新          | 30s/600s 环境策略；串行、恢复、退避、空撤下                  | App/定时器边界       |
| MTE-08 | 服务进程首次、失败、并发请求                        | GET/POST、切账号语言     | seq=0 起、递增不重复；POST 不计；必要头/匿名头               | App/脱敏 HTTP ledger |
| MTE-09 | report 500/断连/账号变化                            | close/成功               | UI 不阻塞、不重试、不借新凭据上报旧事件                      | App/HTTP             |
| MTE-10 | ZIP 冷/热缓存、不同 hash、无效包/来源               | 展示/撤下/重投           | 校验解包复用、lease 释放、坏资源不显示                       | App/Host/文件证据    |
| MTE-11 | bundle ready/error/不 ready/伪造 source 或 instance | 收消息/切主题/隐藏/关闭  | 可信握手才展示；fallback 或隐藏；动作边界                    | App/真实 iframe      |
| MTE-12 | 服务端翻译、空/非法 message、Popup 内 claim         | 失败并关闭提示           | 纯文本、无 msg、恢复原 Popup；无重试/上报                    | App/HTTP             |
| MTE-13 | 复制正常/权限失败/超时/迟到                         | 重复点击、关闭           | 精确文本、成功后反馈与上报、失败恢复、不创建任务             | App/剪贴板           |
| MTE-14 | 设置默认/各分区、市场首页/详情/缺失                 | navigate                 | 目标接管后 confirm、已有目标复用、不安装、不跨身份误确认     | App/配置             |
| MTE-15 | 升级页真实 fixture ready/失败/挂起                  | 打开、提前关闭/超时      | ready 前不 confirm；失败恢复；原升级入口不变                 | App/真实 webview     |
| MTE-16 | HTML/Markdown/plaintext + class/style/theme         | 展示并点击               | 安全样式、无嵌套交互、链接按平台处理、主题和窄屏可用         | App/DOM/截图         |
| MTE-17 | image dark/视频、解码失败/减少动效                  | 展示/隐藏/恢复           | 选择主题资源、暂停恢复、fallback、Banner 96px                | App/媒体             |
| MTE-18 | 新权益/旧权益/当前结构连接                          | 刷新与用户显式连接切换   | 权益呈现与 Subagent 候选联动、不被营销导航覆盖               | App/HTTP/设置        |
| MTE-19 | provider view error                                 | 显示 Root 错误提示并重试 | 不因缺失图标 import 崩溃，重试走原服务                       | App/组件回归         |
| MTE-20 | App 生命周期/Web 支持边界                           | dispose/退出/Web bundle  | 资源释放；Web fallback、不绕过 shared-host；不扩散 task 语义 | Host/跨端代表性验证  |

## Pruning Decisions / Questions For User

MTE-15 补升级 webview HTML 的网络断连、挂起时关闭、30 秒导航超时三项。隔离 HTTP fixture 控制页面响应，不伪造 webview 完成事件；失败时恢复原营销 Popup、无 confirm。释放挂起响应后旧结果不得补报；显式再点且真实页面 ready 才报一次 confirm。finally 恢复服务 ready，stop/reset 释放等待；不涉及购买/支付。

首轮 `desktop-e2e-20260912-034815-613` 三项失败在错误提示断言：`CloudContentDialog` 在 open=false 时卸载实例，升级失败的提示由 `MarketingDialogs` 外层 toast 承担，不能要求恢复后的新实例保留内部 `role=alert`。恢复断言重新定位 Popup 并检查文案、按钮可用、升级容器不存在及事件为空；仍必须验证显式重试才 confirm，不修改产品提示行为。用户已要求达到目标、全套通过后转正，转正验证仅使用本机 Electron，不使用 Docker；当前尚不满足转正条件。

修正后 `desktop-e2e-20260912-035557-133` 本机 Electron 三项通过（38.7 秒，runner exit 0），日志 `/tmp/marketing-upgrade-fault-e2e-2.log`。fixture 单测 15/15、typecheck、desktop typecheck:e2e、lint（45 既有警告/0 错误）和 architecture 通过。当前累计 60 项曾分别通过，不等同于同轮全量通过；尚未证明整体 95%，未转正、未 push。

```text
营销 navigate -> 真实升级 webview -> HTML fail/hold
  -> 断连/关闭/超时 -> 恢复原 Popup（events=0）
  -> 释放旧 HTML -> 用户再次点击 -> 新 webview ready -> confirm=1
```

MTE-17 在原 MTC-RICH 视频 Banner 用例内补减少动效往返：Chromium Emulation 设置 prefers-reduced-motion=reduce 后真实 video 暂停且 autoplay=false；no-preference 后恢复播放，媒体节点不替换，不产生营销事件。finally 清空媒体模拟，不改系统设置或 mock matchMedia；仍使用 Electron 编码的 MP4 经服务下载/准备后展示。

MTE-02 自定义 provider：通过真实设置页 Custom 模板创建空 provider，从导航节点读取真实 providerId；离开模型分区后由营销 navigate 定位该 ID，选中目标并确认上报，持久连接快照和工作区当前模型保持不变。finally 通过详情「更多」菜单中的删除项及确认框清理该 provider，不直接写配置，不配置真实 API key 或发模型请求。

MTE-06 资源阶段失效：已显示的无 Hero Popup 保持打开，新 Banner ZIP 下载在 HTTP fixture 挂起；用户关闭 Popup 使旧准备快照失效，释放 ZIP 后不显示 Banner、不额外上报。排队的下一次 GET 到达作为上一轮资源处理完毕的同步边界，再释放该 GET，服务端新下发相同 Banner 可以显示。资源 gate 只控制 fixture 响应时机，reset/stop 均释放，包内容/哈希不变。

```text
Popup 显示 -> 新 Banner GET -> ZIP 挂起
  -> 用户关闭 Popup -> generation 失效 -> ZIP 完成 -> 丢弃旧准备结果
  -> 下一次 GET 到达并挂起（前轮已收口）-> Banner 不存在
  -> 释放新 GET -> 同 Banner 准备完成 -> 正常显示
```

MTE-13 补充复制平台能力挂起：拦截浏览器 clipboard.writeText 的 Promise，保留真实 App 10 秒能力超时；pending 时关闭不生效且不报 cancel，超时恢复按钮并显示错误。分别在原 Popup 打开/已关闭后兑现旧 Promise，均不得补报 confirm、显示复制成功或复活 Popup。拦截只作用于平台边界，不修改 Controller、计时器或业务结果；原 Promise 兑现不代表真实剪贴板写入，本例不声称验证剪贴板内容。

```text
copy -> 平台 Promise 挂起 -> pending（关闭被拒绝）
  -> 真实 10 秒超时 -> 错误 + 可重试
  -> [保留 Popup / 用户关闭 Popup] -> 旧 Promise resolve -> 不补报成功
```

MTE-12 补充 Popup 内领取失败的三种提示关闭入口（知道了/Esc/遮罩）：HTTP 返回服务端纯文本 message（含 HTML 字面量），错误提示期间原 Popup 不显示；关闭提示恢复同一活动，领取请求仍仅一次且无上报，随后用户关闭原 Popup 才上报一次 cancel。fixture 复用 claim-failure 后 action-delivery 的现有接口，不新增产品入口或计时兜底。

```text
原 Popup -> 用户领取 -> HTTP 失败 -> 原 Popup 隐藏 + 错误提示
  -> 知道了/Esc/遮罩 -> 原 Popup 恢复（claim=1，events=0）
  -> 用户关闭原 Popup -> cancel=1（claim 仍为 1）
```

MTE-11 本批补充：真实 ZIP 在 init 后返回错误 instanceId 的 ready，必须维持未就绪并按原 5 秒时限转 fallback；已 ready 的 iframe 发送错误 instanceId/channel、非法消息结构，不得变成错误态、关闭弹窗或上报。测试仅操纵独立资源响应和真实浏览器 postMessage，不调用产品的消息判定函数。App 组件仍是 iframe readiness 唯一 owner，Controller 的业务状态和动作协议不变。

```text
App init(instance A) -> ZIP ready(instance B) -> 忽略 -> 原 ready 超时 -> fallback
已 ready iframe -> 非法消息 -> 忽略 -> 仍 ready -> 用户关闭 -> cancel 一次
```

不展开所有主题×语言×动作×平台的笛卡尔积；每个副作用/失败边界独立覆盖，纯样式轴按代表组合验证。Lottie 的公共组件分支与旧失败文案无生产调用入口先核实范围，不能用测试注入内部函数凑 95%。若必须改变协议、恢复旧行为或新增测试专用业务入口，先记录并请求决策。当前修复与上述已定契约不需要重新确认。

## Matrix Backfill / E2E Handoff

审计文档保留原始结果不覆盖历史；本文件登记实施阶段；产品语义仍以 marketing-touch-client.md/actions.md 为准。新用例置于 ui-shell/manual-review/pending；使用现有 coding-plan HTTP fixture 扩展 case-local 场景，安全校验使用 synthetic 替身，原因是第三方非确定性。真实 ZIP/媒体/webview，不访问线上领取。隔离 fixture 场景不复用旧账本绝对计数。

覆盖率先固定 baseline 与可执行行映射；禁用跨域整文件假命中合并，未进入 bundle 的业务源码也需列明。运行失败路径经过代码不算行为通过。先测试后修复，执行 typecheck/typecheck:e2e/lint/architecture；完成后提交，不 push；转正仍需人工确认。

## Verification Log

### 第十批：构建源码证据

显式设置 `ZCODE_E2E_SOURCE_EVIDENCE=1` 时，WDIO 对新 desktop 构建前后分别计算 packages/\*/src 的源码 SHA，并记录实际 staged App 的 JS/CSS/HTML/map 哈希到 `build-source-evidence.json`。两次源码相同且有产物才标 fresh-stable；变化、SKIP_BUILD 或 packaged App 不追认当前源码。仅覆盖 desktop 的 Renderer/Host/Main，不证明随后构建或复用的 CLI。全部 IO 异步，不写入源码和凭据，不输出源码正文。

```text
源码指纹 A -> fresh build -> stage App -> 源码指纹 B + staged 产物指纹
A=B 且有产物 -> fresh-stable -> 审计逐文件比较 HEAD SHA
复用/packaged/变化 -> unverified -> 禁止追认旧报告
```

验证：`desktop-e2e-20260912-024849-286` 新构建 E2E 1/1 通过（9.9 秒）；清单为 fresh-stable，2451 个源码指纹、5236 个 staged 产物指纹，构建前后无变化。审计 `/tmp/marketing-source-audit.json` 对当前被审计源码，Renderer/Host/Main 匹配为 true，CLI 保持 false，总百分比仍为 null。5 项采集单测、7 项审计单测及 typecheck、desktop typecheck:e2e、lint、architecture、diff check 通过。该轮是证据采集 smoke，不是全量覆盖率验收；未回填旧报告，未证明 CLI 源码版本。

### 第九批：可重复跨域覆盖诊断

新增只读审计命令 `node scripts/marketing-touch-coverage-audit.mjs <base> <head> <run-dir>`：固定 Git 差异，分别读取 Renderer/Host/Main/CLI 的 Istanbul 映射，支持 `.json.gz`，记录被审计源码 SHA。缺文件/域标 unknown；Node 物理逐行映射和无函数记录标异常提示，UI/Services 在非预期域出现也提示。只输出逐域指标，**不输出跨域总覆盖率或达标结论**；源码 SHA 仅用于追溯，尚不证明报告构建与源码一致。

该工具是对临时脚本的可重复诊断替代，不重新定义 95% 分母。统一可执行行清单、构建指纹核验仍未完成，Node 的物理行指标仍不能充当可执行行指标。纯类型与未映射文件继续显式列出，禁止隐式剔除后报高百分比。

后续第十批为新开启证据采集的 desktop 运行补齐源码匹配；历史无清单报告与 CLI 仍未验证。统一可执行行口径仍未完成。

```text
固定 base/head -> 差异行 + 源码指纹
单轮 Renderer/Host/Main/CLI -> 逐域映射/异常/unknown
  -> 人工核验域与映射（无跨域总数、无自动 95% 结论）
```

验证：6 项 Node 测试通过，覆盖 diff 删除/新增、源码范围、unknown、Node 逐物理行提示、逐域隔离、gzip 与损坏报告拒绝。对 `desktop-e2e-20260912-020726-877` 实跑审计输出 `/tmp/marketing-cross-domain-audit.json`：Renderer 684/900，Host 原始映射 1003/1072，Main 原始映射 1045/1072 却为 0 函数/0 分支，8 个 Services 文件出现在 Main 域被提示。后两项不是统一可执行行覆盖率，不能相加或择高使用；4 个未映射文件仍保留。typecheck、desktop typecheck:e2e、lint 和 architecture 门禁通过。本批未改 App、未新增 E2E 用例、未重跑 App；诊断工具不能单独完成 95% 验收。

### 第八批：富文本安全和链接

MTE-16：真实 HTTP 下发 HTML 的脚本/事件属性/外来命名空间不进入宿主；非法协议、带凭据、不可解析 URL 退为文本，合法 HTTPS 链接经 App 平台打开并 confirm。标题和按钮中的块级/链接转换为非交互行内内容。Markdown 渲染标题/列表但内嵌 HTML 保持文字；超过 32 层嵌套回退原文。仅 mock Electron shell.openExternal 防止实际启动外部浏览器，不 mock 富文本解析器或营销 action。

```text
HTTP text -> inert HTML/Markdown 解析 -> 允许的 React 节点
合法链接 click -> App action -> shell.openExternal -> confirm
非法链接/内嵌脚本 -> 文本或移除 -> 无外部打开、无上报
```

验证：`desktop-e2e-20260912-023559-971` **3/3 通过**（19.6 秒，`/tmp/marketing-richtext-e2e.log`，退出 0）。有效链接经 Electron shell.openExternal 被调用一次、精确 URL 正确、confirm 一次；未实际访问外站。typecheck、desktop typecheck:e2e、lint（45 既有警告，0 错误）、architecture、diff check 通过。本批仅测试及文档变更，保留 pending；未合并跨构建覆盖率，不将本轮局部通过解释为整体 95%。

### 第七批：关闭后的迟到 GET

MTE-06：Banner/Popup 已显示时，HTTP fixture 冻结包含旧投放的 GET 响应。用户关闭并上报后连续触发刷新，释放旧响应；下一 GET 已到达且仍挂起时断言内容未复活（串行 poller 的下一 GET 是前一结果处理完成屏障）。最后解除等待，服务端重新下发同 ID，允许再次展示，不新增客户端历史去重。

```text
旧 GET 快照挂起 -> 用户关闭 -> cancel -> 多次 online 合并后续刷新
释放旧 GET -> App 丢弃旧 generation -> 下一 GET 到达并挂起
  -> 断言仍关闭 -> 解除挂起 -> 服务端同 ID 重投 -> 再次显示
```

验证：`desktop-e2e-20260912-023147-423` **2/2 通过**（14.4 秒，`/tmp/marketing-stale-e2e.log`，退出 0）。fixture 单测 13/13，新增一项证明挂起响应保留关闭前投放，之后新查询为空；typecheck、desktop typecheck:e2e、lint（45 既有警告，0 错误）、architecture 和 diff check 通过。仅测试设施/用例变更；资源准备中的迟到结果、成功动作在途、身份切换仍待补齐，不将这两项扩称完整竞态覆盖。

### 第六批：浏览器解码失败

MTE-17：PNG/MP4 头合法且 SHA 正确、正文损坏的 fixture，必须通过下载类型校验后进入真实 Image/Video 解码失败。图片省略不可用 Hero；视频有可用 fallback 使用图片，fallback 也损坏时省略 Hero（协议要求 video.fallback 必填，不构造缺省的非法数据）。弹窗文案保持可读、不自动上报。以真实 E2E 运行覆盖计数验证 `marketing_image_decode` / `marketing_video_decode` 的拒绝语句执行，区别此前 `marketing_asset_type` 被下载阶段拒绝的测试；本轮采集日志未包含这两条原因，不声称有日志证明。

```text
有效文件头 + 正确 SHA -> Host readMedia 成功 -> 浏览器 decoder error
  -> video fallback / 省略 Hero -> 文案保持、无自动 report
```

验证：`desktop-e2e-20260912-022734-343` **3/3 通过**（21.3 秒，`/tmp/marketing-decode-e2e-final.log`，退出 0）。该轮 Renderer 报告中 `marketingResources.ts` 的 Image/Video decode reject 行计数均为 2，证明浏览器实际走了解码失败分支。fixture 单测 12/12；typecheck、desktop typecheck:e2e、lint（45 既有警告、0 错误）、architecture、diff check 通过。资源清单拆至独立 helper，HTTP fixture 保持行数约束。首次无 video.fallback 的测试被 schema 拒绝，不计为该场景通过证据；修改为损坏 fallback 后通过。未重跑全部 43 项、未更新整体覆盖率，95% 目标仍未达成。

### 第五批：真实 iframe 握手失败

MTE-11：新增专用测试 ZIP，收到真实 init 后按投放 args 返回 error 或保持静默。覆盖 error/5 秒未 ready × 有/无 fallback：有 fallback 显示已校验图片，无 fallback 显示既有 hero error 占位；弹窗仍可关闭且 cancel 一次。另在 ready 的正常 iframe 上，从父窗口发送伪造 error，验证 source 不匹配不能破坏已就绪资源。所有消息经过浏览器 postMessage，不直接调用信任校验函数。

```text
HTTP ZIP -> Host 校验/解包 -> iframe init -> error / 不响应
  -> fallback 图片 / error 占位 -> 用户关闭 -> cancel 一次
父窗口伪造 error -> source 不符 -> 已 ready iframe 保持不变
```

验证：`desktop-e2e-20260912-021641-668` 5/5 通过；拆分故障 ZIP 后 `desktop-e2e-20260912-021946-174` 再次 5/5 通过（48.6 秒，日志 `/tmp/marketing-handshake-e2e-final.log`，退出 0）。最终 ZIP 构造共用辅助函数后，fixture 12 项单测再次通过并逐资源验证实际 SHA；typecheck、desktop typecheck:e2e、lint（45 既有警告，0 错误）、architecture 和 diff check 通过。源码未改，不跨构建合并这两轮覆盖计数；本轮未重跑全部 40 项，不宣称整体 95%。错误 instance、iframe 动作、媒体解码及剩余 MTE 场景仍待补齐。

### 第四批：领取等待期间重复点击

在现有 MTC-03 受控领取响应场景补 MTE-05 断言：HTTP claim 已开始且响应被 fixture 持有时，用户连续点击领取区域三次，仍只有一次 claim、没有提前 confirm。释放响应后保持原来的成功 Popup 与一次上报断言。仅操作公开 DOM，不直接调用 controller 或放开 disabled。

```text
首次点击 -> claim pending -> 重复点击三次 -> claim 仍为 1、confirm 为 0
fixture release -> success Popup -> confirm 为 1
```

单项 `desktop-e2e-20260912-020600-618` 通过；随后三个 spec 同轮 `desktop-e2e-20260912-020726-877` **35/35 通过**（delivery 32、entitlement 1、anonymous 2）。日志 `/tmp/marketing-full-final-e2e.log`，进程退出 0，覆盖报告生成完成。typecheck、desktop typecheck:e2e、lint、architecture 与 diff check 均通过。本批仍仅修改用例和本文档。

同轮基于固定 merge-base `87d6a7b2fc32d088452334c4309f33b0f8b039b1` 对当前工作树差异行，Renderer 映射行覆盖 **684/900 = 76.00%**。仅使用该轮 Renderer 报告，不跨构建合并 statement ID，不与 Main/Host/CLI OR；未映射文件、Lottie 不可达分支、跨域 V8 口径问题仍保留，不能宣称整体 95%。

### 第三批：领取前置安全校验失败与空结果

MTE-05 的该子场景只适用于官方版本的安全校验：校验失败或返回空结果时不提交 claim、不上报
confirm，Banner 恢复可点击；用户再次点击且校验成功后，才提交一次领取并上报一次确认。
用例细节与执行记录随官方版本的 Start Plan 安全校验规格维护。

### 第二批：匿名请求与领取登录拦截

MTE-05/08 的既定子场景：从真实头像菜单确认退出登录，检查测试 HOME 中 JWT 已清除。仅 mock Electron 的 `relaunch/quit` 以免生成 runner 外窗口，随后由 WebDriver 重建真实 App；不 mock OAuth/Marketing Service 或投放组件状态。每例独立 reset HTTP 场景并重启，均从匿名状态开始。

```text
App 退出登录确认 -> OAuth 清理真实测试凭据 -> 原 Host 释放
  -> WebDriver 新 App -> 匿名 GET -> Popup/Banner 关闭 -> 匿名 POST cancel
  -> 点击领取 -> App 登录 UI（不发 claim、不上报 confirm、不运行安全校验）
```

两例均断言真实 HTTP ledger 的 Authorization 缺省；关闭行为不因匿名状态被跳过。领取只打开登录 UI，不模拟完成第三方登录。原登录重启语义不改，测试结束只清理隔离 E2E HOME。

匿名 Banner fixture 使用空按钮文案，由 App 的 `common.close` / `common.open` 提供可访问名称。
E2E 同时匹配中文和英文名称，不能用英文专用定位阻断取消上报与领取登录拦截断言。

测试准备先以空投放进入匿名工作区，再 reset 场景并发出 online 事件拉取，避免营销 Popup 遮挡 WelcomeScreen 的公开跳过入口。退出登录重启 mock 必须 `update()` 同步跨进程调用记录后再断言，直接轮询本地记录会超时。

验证：`desktop-e2e-20260912-015734-173` 新构建真实 Electron E2E **2/2 通过**（51.7 秒；日志 `/tmp/marketing-anonymous-e2e-3.log`）。前两轮分别在准备阶段的 mock 记录同步、WelcomeScreen 被提前投放遮挡处失败，均不计为通过证据。测试保持 pending，不扩展协议、不转正、不 push。加第一批 31 项为 33 个已有通过记录的用例，但本轮只跑匿名两项，不声称 33 项同轮全量通过；未重新计算覆盖率，95% Goal 仍未达成。

### 第一批过程记录

- 实施开始：工作区干净，基线新鲜度通过；代码变更前 architecture 0 违规。
- 首轮新构建：delivery 原有 16 例全通过；权益独立用例修复跨 spec 场景依赖后，暴露旧 `family:bigmodel` 分组断言。当前 `docs/subagents-built-in-model-overrides.md` 明确候选只来自 Environment Selection View，不重新引入 family selected-key；用例改为 registry provider ID。实测切回 Individual 后 Selection View 不再提供原 Start 候选，触发器显示 Select model，保留该断言；不能仅凭 UI 分组源码推断 Start 仍可用。
- 关闭扩展回归：X 两例与普通 Popup Esc 通过；结果 Popup Esc 失败，正在采集实际焦点。遮罩用例首次使用 WDIO 居中相对偏移误点内容，已改绝对视口坐标，待重跑。
- Lottie 无当前营销协议入口，已询问用户是否扩大协议范围；不删除未覆盖分母、不用直接调用内部函数冒充 E2E。
- 多次 `reloadSession` 的 Node 原始覆盖文件直到 worker 结束才归一化，单文件多例会堆积重复 source map。本轮已实际发生 ENOSPC；补齐每例记录结果时的既有增量归一化调用，不丢 counters，不改覆盖口径，失败作为采集错误保留而不覆盖测试结果。
- MTE-10/20 运行证据：同轮 8 个已退出 Host 遗留同 hash 解包目录。根因是 `hasDisposeAllAndWait` 错误要求同时存在 `disposeAll`，漏掉仅异步释放的 CloudContentService；修正结构判断并覆盖等待/同步 best-effort 两条收口，完整 E2E 用多次窗口生命周期验证缓存清理。

### 第一批实现与剩余边界

| 范围       | 本批实现                                                                                                                             | 尚未完成                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 现有用例   | 逐例重启/HTTP reset；迁接 providerId、当前账户 ID、Selection View 分组；真实非空连接快照断言                                         | 自定义 provider 导航的独立 E2E                                           |
| 关闭与上报 | 新增普通/领取结果 Popup × X/Esc/遮罩 6 例；修复 iframe 默认焦点吞 Esc                                                                | 主动进入 iframe 后的键盘边界未扩展协议                                   |
| 请求/故障  | 新增 seq 首次 0/连续递增/POST 不计数、必要请求头、report 500 不阻塞、query 503 恢复 3 例                                             | 匿名/凭据切换、安全校验失败/取消、慢响应竞态、完整退避/隐藏恢复          |
| 媒体/缓存  | 新增主题资源、坏 dark/default 图片、坏 ZIP 有/无 fallback 5 例；原 Bundle 用例追加解包文件不重写和 lease 404；修复 Host 异步清理漏调 | 解码/超时/大小/重定向边界、伪造握手、视频与 reduced-motion、Web fallback |
| 产品修复   | Root 错误态图标、领取后的 ProviderSettingsService 刷新、自定义 providerId 匹配、Popup 初始焦点、异步-only 服务回收                   | 更广 P0/P1 仍按 MTE 矩阵推进，不能宣称全部完成                           |
| 采集设施   | 每例复用 Node 覆盖归一化，避免重启累积 source map 撑满磁盘                                                                           | Node V8/source-map 跨域可执行行口径仍需统一，不能 OR 合并为全分支百分比  |

新增 14 个独立 `it`，加原有 17 个共 31 个，均继续保留 `manual-review/pending`，未转正、未 push。

单元回归：9 文件 50 项通过（`/tmp/marketing-checkpoint-unit.log`）；其中包含故障注入设施、Root/弹窗、领取后刷新、覆盖归一化、异步资源释放和原 CUA/网络回收测试。这些不计入 E2E 覆盖率。

本批最终新构建运行 `desktop-e2e-20260912-013813-308`：**31/31 E2E 全通过**，2 个 spec，WDIO 运行 4 分 27 秒；日志 `/tmp/marketing-phase6-e2e.log`，仓库内报告路径 `packages/desktop/.e2e-artifacts/desktop-e2e-20260912-013813-308/summary.md`。退出清理修复后 Bundle 用例通过多 Host 生命周期、冷/热文件快照和 lease 404 验证。全仓 typecheck 通过，lint 45 warnings / 0 errors，architecture 0 violations，diff whitespace 检查通过。

最终本批的 Renderer 已映射差异行 **679/900（75.44%）**、函数 170/222（76.58%）、分支 568/885（64.18%）。这是全通过 E2E 的覆盖观察，但仍不是全运行域/全分支达标证明；Goal 保持未完成，下一批与范围决策仍按上表推进。

覆盖观察：`desktop-e2e-20260912-012936-023` 为 30/31 通过、缓存目录断言失败的历史运行。按与审计相同的 **Renderer 已映射差异** 口径，行 678/900（75.33%）、函数 169/222（76.13%）、分支 567/885（64.07%）。运行中已执行的失败路径也会计数，因此数字不是通过证明；未映射旧失败文案和 Node 口径问题仍须单列。

`CloudDialogMediaHero` 中 Lottie 两个函数占 48 个已映射可执行行，`cloudLottieRuntime` 占 36 行。当前营销协议没有 Lottie 投放入口，仅此 84 行就使上述 Renderer 900 行分母的理论上限不超过 90.67%。这不是跨运行域整体覆盖率的上限：整体统一分母尚未建立，不能据此断言整体 95% 不可能。Lottie 是否扩展协议/真实入口仍待用户决定；不能自行删代码、缩分母或扩展协议。

仅在 macOS Electron 实测；窄宽度和明暗 UI 断言不等价于手机 Web、Windows/Linux 实机。共享服务释放已回归 Windows Helper 单测，但没有 Windows 实机证据。关系图的 4 条既有悬空边与 HEAD 相同，本批没有新增；代码图工具不可用的限制不变。

2026-10-15 回放前置：delivery 用例固定使用英文界面与 `en-US` 请求头。每例退出旧 Electron 后写入 `locale` 和 `localePreference`，再启动新窗口，避免跟随宿主系统语言或被退出写回覆盖。
