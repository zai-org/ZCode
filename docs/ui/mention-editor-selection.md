# Mention 编辑器选区与 Markdown 合同

## 原因与范围

PromptMentionNode 原来在 TextNode DOM 首部插入 img/svg，同时 getTextContent 返回 canonical Markdown。Lexical 沿 firstChild 找不到实际文字，选区 offset 又与展示文字长度不一致，导致全选端点位于 mention 时内部选区与浏览器选区分叉。

适用于主 Composer（含编辑态）和消息行内编辑共享的 LexicalChatInput（行内编辑将并入 composer 编辑态，见 [Composer 编辑态](composer-edit-mode.md)），覆盖 files、skills、commands、subagents、sessions、whiteboards、plugins。

## 合同

```text
Lexical state
  +-- __text / DOM text -> 展示、光标、原生选区
  +-- markdown         -> 独立序列化 -> onChange / 发送 / 草稿 / 剪贴板
  +-- 图标             -> CSS 装饰，不增加 DOM 文本节点
```

- 保留 TextNode token 原子编辑语义；DOM 文本必须与 __text 完全一致，图标异步失败不替换文字节点。
- getTextContent 返回展示文字；整篇与选区 Markdown 序列化显式读取 mention.markdown。
- 普通文本按选区截取；与选区有实际交集的 mention 输出完整 canonical，剪切删除相同的原子范围。折叠选区与仅接触 token 边界不算交集。
- 整篇输出保留既有段落双换行、LineBreak 单换行和空白语义；选区输出保留 Lexical RangeSelection 的段落分隔规则。对外 getText/getMarkdown、onChange 继续输出 canonical Markdown。
- 复制、剪切注册在公共编辑器层，不依赖候选面板是否启用；剪贴板写入抛错时消费该事件并保留选区，避免落入默认 CUT 删除内容。
- JSON type/version/markdown/mentionId/data 保持兼容；导入旧 text 时规范化展示文字，canonical 不改写。
- 不改变纯文本粘贴行为、发送协议、草稿 owner/key、workspaceIdentity 或远程 session 标识。
- 桌面 desktop-continuous 与手机 web-remote-replayable 沿用各自原链路；本改动只发生在提交之前的编辑器层。

## 接受的用例

| ID | 设置/动作 | 必须断言 |
| --- | --- | --- |
| MSEL-01 | 纯文字、首部/中部/尾部/唯一/相邻 mention，真实平台全选键 | DOM 选区非折叠且完整；全选后替换不残留 token |
| MSEL-02 | 全选后删除、撤销 | 编辑器清空；撤销恢复 canonical 和标签 |
| MSEL-03 | 正反向部分选区，复制与剪切 | 普通文字截取准确，mention 原子输出，剪切范围与输出一致 |
| MSEL-04 | 旧 JSON、多段落、Unicode、图标失败 | 展示长度正确、canonical 不丢失、图标更新保留文字节点 |
| MSEL-05 | 预填后输入与 Option+ArrowRight | 标签保留、正常追加正文 |

优先扩展已有 chat-input-mention-navigation E2E。单测验证序列化与剪贴板命令，真实浏览器验证原生 selection 和编辑效果，不以仅 dispatchCommand 返回 true 作为通过。

代表性组合覆盖桌面 macOS 与 Chromium；Windows/Linux Ctrl+A、手机长按全选和 WebKit 必须单独记录验证状态，不将 Chromium 结果冒充跨平台全覆盖。无需展开 provider、运行态队列或网络故障组合，因为该修复不改变提交及恢复边界。

## 2026-09-04 验证记录

- 修改前：桌面原生 Cmd+A E2E 的 leading/trailing/only/adjacent 四项失败，纯文字和 middle 通过；节点单测明确显示 getTextContent 返回链接而非 label。
- 修改后：7 个 focused 文件共 53 项通过（节点、序列化、剪贴板、试用预填、历史、触发词、slash payload）；其中图标异步失败保留文字与原生选区的单测再次独立通过。
- Desktop macOS / Chromium 146：chat-input-mention-navigation 全部 10 项通过。artifact：`desktop-e2e-20260904072116235-p84305-52c75b5dcb36d31a`。最终复测重建 desktop，复用本任务已成功构建且源码未修改的 Agent 产物。
- 截图：`packages/desktop/.e2e-artifacts/mention-selection/native-select-all.png`，截图复核确认文件图标与全选高亮正常。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint`、conversation coverage audit 均通过；lint 为仓库现有 42 warnings / 0 errors，修改文件无新增告警。
- 测试环境记录：typecheck 会 emit 到 out/host，不能与 Desktop bundle 构建并行，否则覆盖 Host bundle 导致启动失败。最终验证按顺序执行。首次纯文本 setup 使用异步 focus 导致全页选区，已改为真实点击并断言输入框焦点；没有放宽选区断言。
- 待补平台证据：Windows/Linux Ctrl+A、手机 Web 触屏长按、WebKit、浅色主题及消息行内编辑的独立 E2E。共享实现和协议保持兼容，但不将本次 macOS 主输入框证据冒充这些场景已实测。

## E2E lifecycle（本地，无 Docker）

按 2026-09-04 用户授权由 agent 执行复核：将已有 MSEL-01/02/03 的 8 项原生交互回归迁移为独立 `conversation-session-mention-selection`，不增加产品行为。原顶层 spec 保留 MSEL-05 相邻导航用例，避免重复执行。

- Pending：`packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-mention-selection.test.ts`。
- Canonical target：`packages/desktop/test/e2e/conversation-session/composer/conversation-session-mention-selection.test.ts`。
- Provider 合同：`providerRequestPolicy: none`，case-local fixture 与 requests 均为空；在每项用例后断言 provider 请求计数未增加。
- 验证顺序：pending 显式 replay + 截图复核 → fixture check → promotion dry run/apply → formal 显式 common+case replay → default replay。
- 本次不进行 Docker 验证或 admission；跨平台未实测项继续保留。

### Lifecycle 结果

- 用户授权 agent 复核本次用例；对 pending 截图检查文件图标、文字和原生全选高亮正常。
- Pending 显式 common+case replay：8/8 通过，artifact `desktop-e2e-20260904073617029-p6123-ff5d77593b0c1dc3`；provider/runtime capture 的 records 均为 0。
- Fixture check、promotion dry run、apply 与事务内 coverage audit 通过。正式 spec：`packages/desktop/test/e2e/conversation-session/composer/conversation-session-mention-selection.test.ts`。
- Formal 显式 common+case replay：8/8 通过，artifact `desktop-e2e-20260904-073716-750`，证明不依赖 legacy provider fixture。
- Default replay：两个 spec 共 10/10 通过，artifact `desktop-e2e-20260904-073755-068`，包含迁移后的 8 项与顶层保留的 2 项导航回归。
- 本轮只迁移测试归属并增加无 provider 请求的硬断言，没有修改产品代码。未运行 Docker，也未做 Docker admission；不扩大此前跨平台覆盖结论。
- Lifecycle 收口检查：E2E typecheck、根 typecheck、lint（现有 42 warnings / 0 errors）及 conversation coverage audit 全部通过。
