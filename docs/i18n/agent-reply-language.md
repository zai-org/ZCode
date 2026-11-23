# Agent 回复语言（行为设置）

## 行为

- 用户在 设置 › 行为与工具 › 回复语言 里输入一个语言（自由文本，例如 `简体中文`、`English`、`Português (Brasil)`）。Agent 主线程用这个语言回复。
- 留空（默认）不公告，模型跟随对话语言。界面语言（[界面语言](ui-locales.md)）不影响回复语言。
- 语言不进 system prompt。它是一条 `language` 输入附件，只在值变化时追加。system 前缀不变，prompt cache 不失效。
- 一轮执行中途改设置，下一次收集输入附件时生效（完整工具批次之后，或下一条输入）。
- 清空设置后，如果最近一次公告是某个语言，追加一次清除公告，让模型改为跟随用户语言。
- compaction 之后重述最近一次语言公告；最近一次是清除公告时不重述。
- subagent、workflow actor 等非主线程不收到语言公告。
- 会话标题与 goal 摘要标题用最近一次公告的语言生成；历史里没有语言公告或最近一次是清除公告时跟随用户语言。

## 设置入口

- 位置：设置 › 行为与工具，第二组第一行。单行输入框，最多 256 个字符（`REPLY_LANGUAGE_MAX_LENGTH`）。
- 失焦或回车时保存；输入法组字中的回车不提交。Esc 恢复已保存的值。保存前去掉首尾空格；值没变不发请求；空值表示清除，`setting.json` 里删除该字段。
- 保存失败：弹 toast，输入框恢复已保存的值。
- 只有 Desktop 本机显示输入框。Web 远控（含手机）显示"请在本机设置"的提示，不发起写入。

## 唯一来源与拉取时机

每个窗口有自己的 Local Host（[runtime 边界](../agents/runtime-boundaries.md)）。值由 Main 持有并推送给所有窗口的 Host，否则只有发起保存的窗口能拿到新值。

```text
设置页输入框 ──失焦 / 回车──► platform.setReplyLanguage(raw)（IPC zcode:set-reply-language）
Main.applyReplyLanguage
   1. value = raw.trim() || null
   2. 写 setting.json（mainSettingService.update；设置 schema 校验 ≤256；null 删除该字段；
      文件锁与各 Host 的写入串行）。不合法或写盘失败 → 抛给设置页，内存不变
   3. currentReplyLanguage = value（实时值的唯一来源）
   4. reply-language-changed ──► 每个窗口的 Local Host 内存
   5. settings-changed ──► 每个窗口刷新设置快照
Main 启动：spawn 任何 Host 之前从 setting.json 读初值
新 Host：InitLocal 带当时的值；后续变更与 InitLocal 走同一个端口，按序到达

CLI 主线程 collectInputAttachments（轮首 / 完整工具批次后 / 纯文本回复后取出 guide）
   ├─ session/readReplyLanguage（CLI→Host 反向请求，Host 从内存同步应答，不做 IO）
   │  与当前环境读取并发发出；超时 2s
   ├─ 字符串 → 转义后套正文模板；与历史中最近一条 language 公告不同才追加
   ├─ null（没有设置）→ 最近一条是语言公告时追加清除公告；没有公告或已清除时不发
   └─ 读取失败（超时、断连、取消、校验失败）→ 结果未知，跳过，不改变已公告的语言
```

- 连续保存两次：`mainSettingService` 的写队列按序完成，内存最后等于后一次的值。
- 冷重启：Host 先从 InitLocal 拿到值，再 spawn CLI，CLI 不会读到"尚未加载"而误发清除公告。
- Host 不向 CLI 推送语言变化。只有正在执行的会话才拉取；空闲、dormant 会话和空闲 CLI 进程都不读取。
- "已经公告过什么"只看历史，冷恢复不需要额外状态。
- `ZCODE_CLIENT_LANGUAGE`（spawn 时注入，用于 `X-Client-Language`）跟随界面语言，与回复语言无关。

## Host 应答

| Host                                                                       | 应答                     | 依据                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Desktop 本机 Window Host（含手机连本机工作区、本机 Bot、自动化、Off-Peak） | Host 内存里的值或 `null` | 由 Main 经 InitLocal 与 `reply-language-changed` 推送                                                  |
| R3 SSH/WSL/Docker Source Server daemon                                     | `{ language: null }`     | 设置页只写本机 `setting.json`；远端读自己的文件会和设置页不一致（Memory 开关出过同样的问题），暂不支持 |
| Web + Server                                                               | `{ language: null }`     | Web 不提供输入框                                                                                       |
| 旧版 desktop-attached stdio 远端                                           | `{ language: null }`     | 同上                                                                                                   |

依赖注入：只有 Desktop Host 给 `createLocalServices` 注入 `resolveReplyLanguage`，`zcodeAgentService` 用它应答。
没有注入的 Host 一律回答 `null`，不读 `setting.json`。

## 协议

`session/readReplyLanguage`（`packages/shared/src/zcode-protocol/index.ts`）：

- Params：`{ sessionId }`，`.strict()`。`sessionId` 只用于 trace 与日志。
- Result：`{ language: string | null }`，`.strict()`。字符串去掉首尾空格后非空，最多 256 个字符。`null` 表示没有设置。
- 超时：`ZCODE_REPLY_LANGUAGE_REQUEST_TIMEOUT_MS = 2_000`。
- Host 在 workspace 路由守卫之前处理它：值是 Host 级的，不按 workspace 路由；放在守卫之后，服务多个 workspace 的 CLI 会被误拒。

方法放在旧协议文件里：CLI→Host 反向请求（如 `subagents/readRuntimeConfig`、`session/requestRuntimePreferences`）只存在于这一层；它读取 Host 设置，不是聊天能力，不受 [ZCode Protocol](../zcode-protocol.md)"旧协议不承接新的聊天能力"的限制。

## CLI 公告

正文（provider 可见，英文；`<Language>` 是转义后的设置值）：

```text
# Language
Always respond in <Language>. Use <Language> for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.
Maintain full orthographic correctness for <Language>, including all required diacritical marks, accents, and special characters. Never substitute accented characters with their ASCII equivalents (e.g., never write "nao" for "não", "fur" for "für", or "loeschen" for "löschen").
```

- 转义：插入正文前把 `&`、`<`、`>` 转成 `&amp;`、`&lt;`、`&gt;`，把控制字符（`\x00-\x1f`、`\x7f-\x9f`、`\u2028`、`\u2029`）转成 `&#N;`。用户输入不能破坏 `<system-reminder>` 标签，也不能换行插入额外的段落。引号不转义。
- 来源名 `language`，持久化的 system reminder；支持 MCS 时走 mid-conversation system，否则是 user 侧 `<system-reminder>`。
- 顺序：environment → model → output_style_instructions → language。公告的门控与 environment、model 相同（context 有 `env_info` 时），且只对 `main_turn`；拉取只看 `main_turn` 与端口是否注入。
- 清除公告正文：`The language preference was cleared. Match the user's language.`。只在 Host 回答 `null` 且最近一条 `language` 公告是某个语言时发。
- 读取失败不当作清除：失败是暂时的，当作清除会让下一次读取成功时再公告一次，同一个值来回抖动，前缀不稳定。
- compaction 附件：保留段已有 `language` 时不重述，否则重述 compact 前最近一条；最近一条是清除公告时不重述。
- context 组成预演不拉取（不做 IO），会少算一条待发的语言公告。
- 标题：从最近一条 `language` 公告的正文按模板反解出 `<Language>`，并用它重建正文，与原正文逐字相等才算有效（附件 metadata 只有来源名，不另存语言）。有效时把规则 `Use the user's primary language.` 换成 `Write the title in <Language>. Keep technical terms and code identifiers in their original form.`。会话标题与 goal 摘要标题用同一规则。最近一条是清除公告或历史里没有公告时，保持原规则。
- 标题不向 Host 读取，只看历史，所以依赖调度时机：协议路径的 `shouldRefreshBeforeModelRequest()` 恒为 `true`，首轮的会话标题推迟到首轮结束后生成，这时首轮公告已在历史里。`/goal` 首轮的标题不推迟，会与首次收集同时进行，可能按原规则生成。
- TUI 与 headless 没有 Host，不注入拉取端口，不发公告；TUI 的 `/language`（`/locale` 的别名）不变。

## 失败与兼容

- 拉取失败（超时、取消、断连、`-32601`、结果校验失败）只跳过本次公告，不影响本轮执行；下一次收集重新拉取。不缓存失败结果。
- CLI 与 Host 同版本发布，没有版本错配，生产中的 Host 总会应答这个请求。只应答部分反向请求的测试替身要应答它（返回 `{ language: null }`），否则每次收集都要等满超时。
- 旧 CLI 恢复带 `language` 公告的会话：未知来源按旧版本既有规则处理。

## 已知限制

- R3 远端、Web + Server 暂不支持，模型按对话语言回复。后续可按 dynamic workflow 用户模式的方式把设置同步到远端 Host 内存，CLI 仍然拉取。
- 同一台 Desktop 的所有会话共用一个回复语言；手机连本机工作区时用 Desktop 的设置。
- 直接手改 `setting.json` 的 `replyLanguage` 要重启 App 才生效：实时值只来自 Main 内存。

## 验证

- CLI：`apps/zcode-cli/packages/core/tests/runtime-context-announcements.test.ts`（首次公告、不重复、工具批次后重读、失败跳过、`null` 清除、subagent 不读、顺序、转义、反解往返、compaction 重述与清除不重述、标题规则）；`apps/zcode-cli/packages/bootstrap/tests/reply-language-reader.test.ts`（请求参数与超时、`null` 映射、错误原样抛给 core）。
- E2E：`packages/desktop/test/e2e/conversation-session/context/conversation-session-reply-language.test.ts`（RL01–RL09，non-MCS 与 MCS 两种投影各一遍），设置入口见 `packages/desktop/test/e2e/settings/agent/settings-agent-behavior-reply-language.test.ts`（SAB04）；两者已转正。RL 在 `conversation-session/**` 下，随 CI 的 conversation-session 清单运行；SAB04 不在 CI 清单里；两者都没有做 Docker 准入。已转正的 `settings/agent/settings-agent-behavior.test.ts`（SAB01/SAB03）同步覆盖这一行的分类清单与布局。
- Web 远控：浏览器验收，确认显示本机提示（深浅主题）。
