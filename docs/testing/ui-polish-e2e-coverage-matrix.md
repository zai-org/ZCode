# UI Polish E2E Coverage Matrix

- Logo 样式迁移：UP-00 验证 Windows 设置页旧位置与 18px 底座、11px 静态 SVG。Windows 实测通过：`desktop-e2e-20261009065931122-p21208-9f6085045aa4ea21`，1/1；明暗主题截图已检查。

## Todo153：思考档位展示与配置顺序

依据 [控件 spec](../ui/chat-thought-level-control.md) 和 [Todo153](../working-memory/provider-refactor/steps/todo-153-thought-level-display-mapping.md)，以下语义已确认，浏览器候选位于 `packages/ui/test/browser/manual-review/pending/thought-level-display.test.mjs`，fixture 使用真实共享控件、SubagentReasoningField 及 toolbar 快捷键 hook，隔离设置服务，不发送模型请求。

| 用例  | 前置与动作                                                                                                                           | 断言                                                                                                | 状态                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------ |
| TL-01 | 同一配置包含关闭、minimal／low、max／ultra、extra-high／extra_high、default；桌面 1200／触控手机 390，中英与深浅主题；打开菜单并选择 | 文案符合 spec；同名别名不去重；default 保留来源名称；菜单尊重配置顺序，提交原始 value；视口内无溢出 | accepted；浏览器八组通过，待人工转正 |
| TL-02 | 上述尺寸与主题下依次操作选择菜单、点击循环、Ctrl+T 及 Subagent 字段                                                                  | 共用配置顺序并在末尾回首；快捷键不打开菜单；Subagent 显示相同文案并提交原始值                       | accepted；浏览器八组通过，待人工转正 |

关闭项位于中间、未知值名为 off、空值／失效值与单档只读由定向组件单测覆盖。浏览器截图用于视觉检查；本组不代表完整 Electron、手机远控重连或供应商请求链路验证，不自动转正到正式桌面 E2E。

## 2026-09-12 当前整页验证

以本节取代下方已退出的 AddProviderCard footer／智能开关旧位置描述。MP-UI-01 验证四智谱模板分组、返回原选择、DeepSeek 两默认成员、原子创建与直接进入详情；MP-UI-04 从 Provider 更多菜单删除，并确认导航和 Personal 同时移除；MP-UI-06 按当前帮助标题、身份行智能开关和恢复按钮布局验证真实编辑、取消、保存、档位排序及两个视觉标入口。

Pro 最终 `provider-20260912-pro-settings-polish4`：WDIO 报9 passing／1 skipped，其中 UP-00 在 macOS 提前返回，**不代表 Windows 通过**；8项实际执行通过，SSH用例缺环境跳过。初次失败不是产品回退依据：测试漏接菜单／帮助标题／最终 DeepSeek 目录；另有 UP-01 未关闭菜单造成后续滚轮被模态指针屏障拦截。已修测试，保留完整滚动断言，未改产品。MP-UI-01 单独执行也通过。

日志 `/tmp/provider-20260912-pro-settings-polish{,2,3,4}.log` 与 `/tmp/provider-20260912-pro-create-isolated.log`。390px 中英深浅编辑截图已检查：标题、分组与操作按钮位于视口内，Map 仍多行，正文区独立滚动；不是手机 shared-host 实机。

## Todo98 源 Map 结构排版

F98-03（accepted，pending 不晋级）：复用 `settings/manual-review/pending/provider-model-smart-config.test.ts`，添加/编辑读取真实 Built-in 多行 Map，桌面及 390px 截图；真实键入连续空格不触发背景排序，取消无写入，正常保存后原样读回。Pro `desktop-e2e-20260909-125010-082`：SC90-01 / F98-03 **2/2 通过**。F98-01 扫描真实 Built-in 所有 Map 的结构换行及简单三目；F98-02 全部 65 条 AST 与 505 组求值对照通过，无运行时 formatter。390px 仅布局模拟，不冒充真实手机远控验证。追加键盘隔离有 7 类控件/Portal 负例及模型行键盘启动正例。

## Feature Summary

Todo103 候选回归：MP-UI-06 的 Hover/键盘焦点颜色比较须等待被测控件现有 CSS 动画完成，再读取最终计算样式。不能把过渡帧作为推荐样式，也不通过删除动画、放宽颜色断言或延长固定 sleep 让测试通过。2026-09-09 Pro 原运行捕获到 Hover alpha=0.047、焦点最终 alpha=0.05，属于测试采样竞态；产品样式与原裁决不变。

| Field                 | Value                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Change                | Profile menu preference order; model-provider empty and add-provider states                    |
| Change layer          | Presentation + provider connection validation                                                  |
| Operating mode        | implementation-handoff                                                                         |
| User-visible surfaces | Desktop sidebar profile menu; desktop/web model-provider settings                              |
| Existing specs        | `docs/desktop/sidebar-zoom-menu.md`, `docs/model-provider-family-merge.md`                     |
| Out of scope          | Model request traffic, mobile replay recovery, remote workspace runtime, provider billing APIs |

## Impact Brief

### UI Surface Matrix

| Scenario                                 | UI entry                                    | Shared implementation               | State owner / source                      | Validation / gating                                                   | Commit sink                                          | Mode boundary                                      | Isolation invariant                                                      |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Inspect preference order                 | Sidebar avatar menu                         | `WorkspaceSidebarFooter`            | React props + desktop zoom platform state | Zoom is desktop-only                                                  | Existing theme/locale callbacks and desktop commands | Order is shared; zoom remains desktop-only         | Opening the menu must not mutate preferences                             |
| Inspect add-provider guidance            | Settings > Model provider > Add provider    | `AddProviderCard`                   | Local add-provider draft                  | Add action disabled until required fields and a model exist           | Existing model-provider service create action        | Responsive desktop/web layout                      | Hint must not create a second validation rule                            |
| Delete the final editable provider model | Settings > Model provider > Custom provider | `ProviderModelsSection`             | Model-provider registry                   | Empty list is allowed for an existing provider                        | Existing provider update action                      | Desktop/web share UI; no replay semantics involved | Empty models remove chat candidates while preserving the provider editor |
| Resolve a zero-model Coding Plan         | Provider family connection resolver         | `resolveCodingPlanEntitlementState` | Model-provider registry                   | Connection requires credential + endpoint, not a non-empty model list | No UI mutation                                       | Shared pure resolver                               | Empty models must not disconnect entitlement                             |

### Ranked Relationships

| Rank           | Relationship                                           | Reason                                                                            | Evidence                                        |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| must-inspect   | Provider settings -> model-provider service            | Deleting the final model persists through the existing provider update path       | `ModelProviderSection`, `ProviderModelsSection` |
| must-inspect   | Coding Plan visibility -> provider connection resolver | The regression was caused by treating `models.length` as a connection requirement | `providerFamilyConnectionVisibility.ts`         |
| should-inspect | Add-provider footer -> add-provider draft validation   | Guidance and disabled action must agree                                           | `AddProviderCard.tsx`                           |
| conditional    | Profile menu -> desktop zoom commands                  | Zoom appears only in Electron desktop mode                                        | `WorkspaceSidebarFooter.tsx`                    |
| invariant-only | Provider settings -> chat model picker                 | Zero models means no selectable chat model, without changing plan identity        | `docs/model-provider-family-merge.md`           |

### Codegraph Evidence

The repository declares `surface.provider-settings -> service.model-provider` as a
`must-inspect` edge in the feature graph. A live codegraph tool is not available in this checkout,
so depth-2 verification uses direct imports/callers and existing E2E helpers. The sidebar profile
menu is a graph-drift candidate because its preference surface is not yet declared in the curated
feature graph; this test task does not change its state or persistence contract.

## Boundary Decisions

| Decision                         | Status   | Included                                                                        | Pruned / reason                                                                                                                                           |
| -------------------------------- | -------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UP-01 profile menu order         | accepted | Visible top-level order in desktop mode                                         | Theme and locale value changes: existing behavior, unchanged by this branch                                                                               |
| MP-UI-01 add-provider footer     | accepted | Divider, info hint, DOM/visual left-right order, disabled action                | Provider request/send: already covered by P0-02                                                                                                           |
| MP-UI-02 empty editable provider | accepted | Delete the final custom-provider model; empty hint and Add Model remain visible | Coding Plan models are server-synced/read-only, so zero-model connection stays resolver-unit coverage; Team/Start/Z.ai variants are pairwise unit-covered |
| Locale variants                  | pruned   | One runtime locale plus exact zh/en locale unit assertions                      | Layout uses the same message id and responsive flex contract                                                                                              |
| Theme variants                   | pruned   | Semantic classes asserted by unit test                                          | No theme-specific branch or raw color was added                                                                                                           |
| Mobile/remote runtime            | pruned   | Responsive class contract remains unit-covered                                  | No process, protocol, replay, owner, or workspace identity change                                                                                         |

## Accepted Cases

2026-09-08 Todo93 C93-01～12（已实现 / 已验证）：套餐同身份失效只提示一次，点击具体目标才切换；覆盖重复刷新、身份切换、启动基线、unknown/pending、旧按钮竞态及条件写入失败。旧 Todo88 R06 / SPMC-08 的“刷新即自动切换”预期已被替代，历史通过不代表新契约通过；已保留该链路覆盖并补真实点击、点击前不写/点击后读盘断言；Pro desktop-e2e-20260908-101239-586 4/4 通过。完整场景和隔离 E2E 交接见 [Todo93](../working-memory/provider-refactor/steps/todo-93-account-plan-loss-manual-switch.md)。

2026-09-08 最终裁决：撤销 Todo92 的 G92 分组恢复用例和 `provider-model-group-reset.test.ts` 实验用例。正式计划改为 Todo92 F92-01～08：个人覆盖边框逐项表达、档位整体而 Mapping 独立、Hover/聚焦同背景、MFJS 无前置复选框、容器标题收敛；与 Todo90 M90-01～08 联合验证“智能配置”开启/关闭、全部必填、不按名称匹配、取消和保存。已按最终契约实现并通过联合验收，旧 Air 预览不计作证据；不显示“自定义 · 恢复推荐”，不加分组或全局恢复按钮。

2026-09-08 Todo 89 补充 W89-05/W89-08（accepted）：隔离配置中的个人模型缺失 contextWindow 时，设置页仍可打开编辑、保存修复、启停和删除；重复添加由真实写入入口拒绝，失败后弹窗和输入保留，成员不能重复。继承成员删除保护由 DOM/服务用例覆盖。新增 pending `settings/manual-review/pending/provider-settings-write-recovery.test.ts`，人工审阅前不转正式门禁。配置来源是配置解析快照而非仅可执行 Registry；未修复的模型不能出现在可执行选择中。此项以 Todo89 和当前 Provider spec 为准，不沿用本页历史表格中旧 Service/只读账号模型描述。实际运行记录见 Todo89 的验收表。

2026-09-07 Todo 88 / R08、R13 补正：模型编辑弹窗明确保留两个常显分组，“推理设置”包含档位和 Mapping，“高级设置”包含 MFJS；不是旧折叠高级区。跟随推荐开关位于保存/取消操作行，小屏沿用同一表单操作组件换行。MP-UI-06 增补：关闭跟随后取消，重开仍跟随；关闭后保存，重开仍固定且保留原编辑；固定切回跟随后再编辑 Mapping，保存重开保留新值。验证实际持久化，不仅断言草稿或 CSS。继续覆盖带前后缀的长模型 ID、中英/深浅主题、390px 编辑布局；开启图片能力保存后，设置模型行和普通选择菜单都展示视觉标记。新增验证待 Pro 运行，不沿用下方旧证据计为通过。

| Case     | Setup                                 | Action                 | Assertions                                                                                             | Evidence                     | Status   |
| -------- | ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------- | -------- |
| UP-01    | Desktop workspace ready               | Open avatar menu       | Language, theme, zoom appear in the committed top-level order                                          | Electron DOM + unit          | promoted |
| MP-UI-01 | Default provider settings             | Open Add provider      | Four Zhipu templates grouped; template/custom creation opens persisted detail; outer page scroll works | Electron DOM/geometry + unit | promoted |
| MP-UI-02 | Custom provider starts with one model | Delete its final model | Empty dashed hint and Add Model action remain visible                                                  | Seeded files + Electron DOM  | promoted |

## Coverage Goal

- Every changed branch in `providerFamilyConnectionVisibility.ts` is covered by unit tests.
- Every added render branch and class contract in `AddProviderCard.tsx` and
  `ProviderCardSections.tsx` is covered by unit tests and one real Electron path.
- The sidebar order is covered by an Electron DOM-order assertion; callback and desktop zoom
  command behavior remain covered by their existing tests.
- Targeted V8 coverage is measured for the four changed source files. `100%` is a goal for changed
  lines and branches; unreachable framework/bootstrap code is reported rather than hidden.

## E2E Handoff

- Formal spec: `packages/desktop/test/e2e/settings/general/settings-ui-polish.test.ts`
- Provider fixture: none; the case seeds local provider/settings files and performs no model request.
- Timing: ordinary UI waits (`fast-text` equivalent), no stream timing.
- Docker preset: settings/default desktop suite after manual review and promotion.
- Human review confirmed on 2026-08-19; settings-domain promotion completed without conversation fixtures.

## Runtime Evidence

- Formal Electron run after promotion: `desktop-e2e-20260819044246639-p7031-0eaf856fbfb1eeae`
- Formal result: 3/3 passed without `ZCODE_E2E_MANUAL_REVIEW`.
- Formal artifact: `packages/desktop/.e2e-artifacts/desktop-e2e-20260819044246639-p7031-0eaf856fbfb1eeae/summary.md`.
- Electron manual-review run: `desktop-e2e-20260819042607776-p64629-52e741b6f1da02f5`
- Result: 3/3 passed (UP-01, MP-UI-01, MP-UI-02).
- Artifact: `packages/desktop/.e2e-artifacts/desktop-e2e-20260819042607776-p64629-52e741b6f1da02f5/summary.md`.
- No provider request is made, so no replay fixture or timing class is required.
- Targeted V8 run covered 100% of executable lines added by this branch in the four changed source files;
  whole-file percentages are intentionally not presented as 100% because those components contain unrelated legacy paths.

## 2026-09-08 Todo90 / Todo92 最终执行证据

Pro `desktop-e2e-20260908-110541-867`：3 specs / 9 cases 通过；SC90-01 新 pending 用例覆盖添加固定模式、空输入拒绝、取消不写、编辑重开及保留禁用状态，原 MP-UI-06 继续验证编辑、档位排序、Mapping、Model Selection 消费，扩展 390px 双主题/中英与 Hover/焦点、标题不裁切断言。其余 UP-01、MP-UI-01～05、Todo89 W89-05/08 修复入口回归通过。

M90-01～08、F92-01～08 以 317 条相关单测和上述代表 Electron 联合覆盖；完整 case 剪枝与未验证端见 Todo90 §8 / Todo92 §7。源生命周期、身份、失败注入使用受控 Promise/真实 Runtime 写入测试，不复制所有账号品牌组合。新用例保留 `settings/manual-review/pending/provider-model-smart-config.test.ts`，未自动转正。Pro 截图 `packages/desktop/.e2e-artifacts/todo90-92/model-editor-{dark,light}-390.png` 已检查；不是 Air 历史预览，也不冒充真实手机远控验证。

## Menu radius migration (2026-09-04)

以下为固定 staging 的来源规范与历史运行证据；Todo103 完整候选仍需共享回归，不继承历史“通过”为本次通过。

- Spec: [DESIGN.md Radius](../../DESIGN.md#radius).
- Scope: shared DropdownMenu, ContextMenu and Select expanded panels use `lg`; items (including checkbox/radio items and submenu triggers) use `md`; submenu shells restart at `lg`. Select triggers are unchanged.
- Accepted: UP-01 additionally reads computed radii from the opened profile menu (8px shell, 6px items at the default root size). Shared component contract tests cover all three implementations and submenu variants.
- Desktop and mobile Web share these primitives and theme-independent radius utilities. This change adds no process, clientMode, deliveryKind, stream or recovery behavior.
- Separate mobile and cross-OS visual runs remain outside this targeted desktop check.

### Migration verification

- Red: the new shared-radius and business-override contract tests failed against the old styles.
- Green: 22 targeted unit tests passed; `pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e`, and `pnpm lint` passed (41 existing lint warnings, no errors).
- macOS Electron: `settings-ui-polish.test.ts`, 3/3 passed, including computed menu shell/option radii. Run: `desktop-e2e-20260904075731227-p32863-d53541f289639947`.
- Windows caption and automation/off-peak menu overrides were removed so these surfaces inherit shared radii. ContextMenu, Select, checkbox/radio items and submenus have contract coverage; their individual runtime paths and mobile/Windows/Linux visual checks were not run in this change.

## macOS 根框架背景（2026-09-04）

UP-01 在 macOS 上增加 `DesktopWindowFrame` 计算背景透明断言。这是当时透明根背景规则的历史验证记录；当前根背景规则以 [DESIGN.md](../../DESIGN.md#color-usage-rules) 为准，不将本段历史通过结果视为当前行为；单测覆盖 macOS、Windows、Linux 与 Web 的背景分支。仅改变根背景样式，不改变子区域背景或远控行为。

- 验证：修改前 macOS 单测失败，修改后四个平台分支单测全部通过；全仓类型检查、E2E 类型检查和 Lint 通过（41 个已有警告、0 错误）。
- macOS Electron：3/3 通过，根框架计算背景为 `rgba(0, 0, 0, 0)`；运行 ID：`desktop-e2e-20260904082702490-p81892-0a8af92f6cb52575`。
- Windows/Linux/Web 背景分支已做单测，未做独立平台视觉验证；设置页和错误页复用同一组件，未逐页截图验证。

2026-10-09 平台尺寸：UP-00 Windows 设置页 6px 外沿、8px 圆角和右上操作组对齐通过，run `desktop-e2e-20261009070918592-p12424-e7971ff15e21066b`。
