# 界面语言（UI Locales）

## 支持的语言

| Locale  | 本名（菜单显示） | 文案表                                  |
| ------- | ---------------- | --------------------------------------- |
| `zh-CN` | 中文简体         | `packages/ui/src/i18n/locales/zh-CN.ts` |
| `en-US` | English          | `packages/ui/src/i18n/locales/en-US.ts` |
| `ja-JP` | 日本語           | `packages/ui/src/i18n/locales/ja-JP.ts` |
| `ru-RU` | Русский          | `packages/ui/src/i18n/locales/ru-RU.ts` |
| `ko-KR` | 한국어           | `packages/ui/src/i18n/locales/ko-KR.ts` |

唯一事实源：`packages/shared/src/protocol.ts` 的 `SUPPORTED_LOCALES`（`Locale` 类型由它推导）。
本名表 `LOCALE_NATIVE_NAMES` 与辅助函数在 `packages/shared/src/locale.ts`。
设置页语言下拉、侧栏个人菜单「界面语言」和 `LocaleSwitcher` 都按 `SUPPORTED_LOCALES` 渲染，
选项显示本名，不随界面语言翻译。手机 Web 远控复用同一个设置页组件。

## 跟随系统

`resolveLocaleFromLanguageTag(tag)`：`zh*`→`zh-CN`，`ja*`→`ja-JP`，`ru*`→`ru-RU`，`ko*`→`ko-KR`，
其它与空值→`en-US`。Main（`resolveSystemApplicationLocale`）、Renderer（`navigator.language`）、
ErrorBoundary 都用它，不再各写 `startsWith("zh")`。

## 回退策略

1. 文案：`ja-JP`/`ru-RU`/`ko-KR` 合并为 `{ ...enUS, ...<locale> }`（`i18n/localeMessages.ts`），
   缺 key 显示英文，不露出 key。`zh-CN`、`en-US` 是完整表。
2. 只有中英两套内容的地方用 `toZhOrEnLocale(locale)`：中文走中文，其它走英文。适用于：
   官网/奖励/Coding Plan webview、社群链接、分享站路径、Provider 模板名、内置 Skill 描述、
   营销投放内容渲染、发版说明、机器人消息、手机推送、Main 原生菜单/关于/Finder/右键菜单/日志导出提示、官方版本的请求安全校验界面语言。
3. 不翻译的内容：日志、协议值、命令、错误码、服务端回传的中英内容。不为新语言新增 key。

## X-Client-Language

规则：发往 ZCode/BigModel 服务端的请求，`X-Client-Language` 等于当前界面语言的 BCP-47 值
（如 `ja-JP`），切换后下一个请求立即生效；不能先降级成中英。详细链路见
[ZCode Endpoint Client Language Header](../zcode-endpoint-client-language-header.md)。

## setting.json 存储格式与降级兼容

问题：v3.17.x 及更早版本的设置 schema 是 `locale: z.enum(["zh-CN","en-US"])`、
`localePreference: z.enum(["system","zh-CN","en-US"])`，没有 `.catch`。读到 `ja-JP` 等新值时
`appSettingsSchema.safeParse` 失败，`settingService` 把**整份设置**当默认值返回；之后旧版本任意一次
`update()`（改设置、窗口尺寸、最近项目等）都以默认值为底合并写盘，磁盘上的全部设置被覆盖丢失。
降级、或测试版/正式版共用 `~/.zcode/v2/setting.json` 时都会触发。

存储格式（统一由 `packages/shared/src/locale.ts` 的函数读写，不要在别处手写）：

| 字段                 | 内容                                                              | 谁读         |
| -------------------- | ----------------------------------------------------------------- | ------------ |
| `locale`             | `toZhOrEnLocale(真实语言)`，只有 `zh-CN`/`en-US`                  | 旧版本       |
| `localePreference`   | `system`/`zh-CN`/`en-US` 照写；`ja-JP`/`ru-RU`/`ko-KR` 写 `en-US` | 旧版本       |
| `uiLocale`           | 真实界面语言（如 `ja-JP`）                                        | 新版本优先读 |
| `uiLocalePreference` | 真实界面语言偏好（`system` 或具体语言）                           | 新版本优先读 |

- 写：`settingService` 写盘时用 `toPersistedSettingsLocaleFields(settings)` 覆盖这四个字段。
  偏好降级成 `en-US` 而不是 `system`：`en-US` 与 `locale` 的降级值一致，也是新语言的文案回退语言；
  降成 `system` 时中文系统上旧版本会显示中文，离用户“选了非中文语言”的意图更远。
- 读：`appSettingsSchema` 的 preprocess（`applyPersistedUiLocaleFields`）用
  `resolvePersistedUiLocale` / `resolvePersistedUiLocalePreference` 把新字段合并回内存的
  `locale` / `localePreference`；新字段只有在“降级后等于旧字段”时才采信，否则以旧字段为准
  （旧字段被手改或被只认旧字段的写入者改过）。内存 `AppSettings` 不含新字段，`locale` 始终是真实语言，
  所以 X-Client-Language、`ZCODE_CLIENT_LANGUAGE`、遥测、Host 兜底等消费方不感知这层转换。
- 直读原始 JSON 的地方也必须新字段优先：Main 冷启动同步读取（`desktopApplicationLocaleBootstrap.ts`）
  用 `resolvePersistedUiLocale`；其它读设置的地方都经 `settingService` / `appSettingsSchema`。
- 旧版本 schema 的顶层 `z.object` 默认 strip（无 `.strict()` / `.passthrough()`），读到新字段不报错，
  但它写盘时会丢掉新字段：降级后再升级，界面语言回到旧字段的降级值（如 `en-US`），其它设置不丢。
- 开发期内部版本曾把 `ja-JP` 等直接写进旧字段：新版本照常识别；`shouldPersistSettingsMigrations`
  检测到旧字段含旧版本不认识的值（`hasLegacyIncompatiblePersistedLocale`）时立即按新格式迁移落盘。
- 渲染进程 localStorage `zcode-locale-preference` 可能存 `ja-JP`；旧版本读取时会校验并忽略未知值，不影响设置。
- E2E：`settings/general/settings-client-language-header.test.ts` 的 CLH-03/04/05 断言落盘格式与冷启动请求语言。

## 加新语言的步骤

1. `SUPPORTED_LOCALES` 追加 locale；`LOCALE_NATIVE_NAMES`、`LocaleSwitcher` 的短标签补一项。
2. `resolveLocaleFromLanguageTag` 加主语言前缀映射。
3. 新建 `packages/ui/src/i18n/locales/<locale>.ts`（只翻译 `en-US.ts` 已有 key，保持 `{name}` 占位符一致），
   在 `i18n/localeMessages.ts` 以 `{ ...enUS, ...新表 }` 登记。
4. 跑 `pnpm typecheck`：所有 `Record<Locale, …>` 穷举会报错，逐个决定补内容或改用 `toZhOrEnLocale`。
5. 检查「本周」起点（`project-sidebar/timelineDates.ts`）等地区习惯。
6. 跑 E2E `settings/general/settings-client-language-header.test.ts`。

## 已知限制

- Agent（`apps/zcode-cli`）发出的模型请求仍用 Agent 进程的 `Intl` 语言，需要 App→Agent 传递界面语言（待定方案）。
- 降级到旧版本后界面语言显示为中/英降级值；旧版本写盘会丢弃 `uiLocale`，再升级时需要重新选择日/俄/韩语（见上文降级兼容）。
