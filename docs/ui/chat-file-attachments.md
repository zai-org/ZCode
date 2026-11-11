# Chat File Attachments（当前事实）

附件由 V4 composer 管理。用户选择、粘贴或拖入附件后立即预传；只有已获得
`AttachmentRef` 的 `ready` 附件才能随 `sendText.attachments` 提交。

发送准入统一使用“正文或附件至少一个”：`text.trim()` 非空，或存在至少一个有效
`AttachmentRef`，二者满足其一即可。只有附件的 draft、idle send、running queue 和
query edit 都是合法输入；正文和附件同时为空时返回 `proto.invalidPayload`。

## 状态与门禁

```text
waitingSession -> queued -> uploading -> committing -> ready
                              |
                              +-> transient failure -> 500ms 后自动重试一次
                              +-> failed -----------> 用户手动重试
```

Renderer 以 `workspaceKey + composer scope` 保存上传状态；`workspaceKey` 统一取
`workspaceIdentity?.trim() || workspacePath`。该状态不进入 relay/main，也不持久化浏览器
`File`，但任务切换或 composer 局部卸载后仍可恢复并继续当前上传。

- 上传并发上限为 2；进度单调，commit 前最高为 99%，commit 成功后显示 100% 约 300ms。
- 任一附件非 `ready` 时，发送按钮和 held-queue 两个选择按钮均禁用；submit 入口再次校验，禁止产生 `sendText` 或任何 queue command。
- 自动重试最多 1 次；手动重试开启新的重试预算。上传成功不自动发送。
- 删除附件会 abort 在途事务并清理暂存内容。CLI/runtime 换代使未提交 ref 失效，并按原重试预算重新上传。
- 上述清理只适用于未提交 composer 附件。编辑已发送 query 时删除附件只更新新 active branch
  的引用列表，不删除旧 branch 使用的本地文件、artifact 或远端暂存内容。
- 附件草稿和上传状态按 `workspaceKey + composer scope` 隔离；切换 task 不取消后台上传，切回后继续显示。

## 传输路由

```text
本地 desktop localPath ----------------------------> ready（零拷贝）
SSH/WSL/Docker localPath -> host transfer -> remote stage -> ready
Web/inline bytes --------> V4 begin/chunk/commit ---------> ready
```

- 本地 desktop 真实路径不伪造上传进度。
- Web/inline 使用现有 V4 chunk transaction，wire schema 不变；高层 put 提供进度和取消。
- SSH/WSL/Docker 由桌面 host 把 host-local path 传到 remote runtime 可读的暂存路径，不允许把桌面路径直接交给远程 Agent。
- relay 和 desktop main 只透传 RPC，不保存附件草稿、进度、queue 或 session 业务状态。

## 粘贴图片的派生路径

剪贴板图片继续以 session-scoped data URL artifact 作为持久化事实。artifact commit 完成后，
CLI 会在独立的 session-scoped image cache 目录中 eager 物化一份真实图片文件；该文件只是
可重建的派生缓存，不写入 `AttachmentRef`、conversation transcript 或 replayable snapshot。

```text
<storageRoot>/cli/
  ├─ artifacts/<sessionId>/...                              # durable artifact
  └─ image-cache/<sessionId>/image-<artifact-uri-hash>.<ext> # derived image
```

本节只定义派生图片与 durable artifact 的路径隔离；不新增定期清理或旧路径迁移语义。

```text
paste -> durable data URL artifact -> eager image file
send  -> ensure image file path
          ├─ 写入中：等待同一任务
          ├─ 已存在：复用
          └─ 不存在：从 durable artifact 重建一次
```

URI singleflight 的生命周期独立于单次 query，不接收 caller-owned `AbortSignal`。paste 与发送
直接复用并等待同一个物化 Promise，避免某个请求的取消传播到共享缓存任务。

## Composer PDF 附件

PDF 是独立的 prompt attachment 类型，但复用 image/video 的 admission、artifact、FilePart、
derived cache、恢复和请求前能力投影边界。PDF 在 UI 中保持文档文件卡片，不进入图片媒体宫格；
Composer 草稿和已发送 user row 均可打开现有 PdfViewer。

```text
local/staged path 或 V4 upload bytes
  -> TurnAttachment(type=pdf)
  -> 校验 MIME、20MiB 上限和 %PDF magic
  -> durable zcode-artifact:// URI
  -> part.data 中的 FilePart link + metadata
  -> <storageRoot>/cli/pdf-cache/<sessionId>/pdf-<uri-hash>.pdf
  -> request 前 materialize path，再按 supportsPdf 做 omit/restore
```

- Web/inline PDF 沿用 V4 20MiB、512KiB chunk 和现有 upload transaction；Desktop local/staged
  PDF 不在 renderer 内联 base64，由 Agent 在 admission 时有界读取。
- artifact 是附件事实来源；`part.data` 不保存 base64 或 cache path，`pdf-cache` 是可重建派生文件，
  不进入 transcript、snapshot 或 replayable event。
- 当前 live turn 可复用 runtime 可访问的 local/staged path；冷恢复、历史消息和模型切换必须按
  `artifact -> pdf-cache` 优先，不能让旧 local path 覆盖 artifact 内容。
- 已发送 PDF 预览按精确 session/row/part 授权，通过 `attachment/read` 的 offset/limit 分片读取；
  artifact 存在但物化失败时只降级到 artifact chunks，不回退到可变原始路径。
- `supportsPdf=true` 保留 PDF file block 与 `[PDF: source: <path>]`；`supportsPdf=false` 只 omit
  provider-visible PDF data，保留 source 文本。每次请求重新投影，不修改持久化历史。
- 不新增 attachment DB 表。已有 `application/pdf` FilePart 直接 hydrate；只有旧 local path 的
  历史附件在请求前尝试重新 artifact 化，源文件失效时保留明确不可用的 source 文本，禁止按 UTF-8
  普通文件解码。

最终 provider 请求在同一个真实 user content 中追加普通文本
`[Image: source: <absolute-path>]`：支持图片的模型收到 image block 和 path；只有明确
`supportsImages === false` 时 image block 才替换为既有 media-omitted 文本，path 仍保留。
path 不经过 system reminder、runtime attachment 或 MCS。多图保持全部 image/omitted block
在前、全部可用 path block 在后。已有真实本地路径的图片直接复用原路径，不生成派生副本。
派生缓存不支持某个图片 MIME 时走 best effort：保留原 image/base64 provider 链路，只跳过该图的
cache/path；受支持 MIME 的真实 IO 或 durable artifact 故障仍在 provider 调用前明确失败。

## UI

- 图片沿用紧凑缩略图，中央覆盖圆形进度环和百分比。
- 桌面附件按钮通过现有文件输入取得 `File` 以显示图片草稿缩略图；`getPathForFile` 同时保留本地路径，发送继续使用原路径路由，不把图片字节放入 RPC。选择器中的本地非图片附件继续只保留路径，此优化不得用于拖拽、粘贴或程序化加入的附件。
- 拖入、粘贴或程序化加入的 `File` 保留 `objectUrl`，即使桌面端解析出本地路径，也不能因此丢弃视频和 PDF 的 Composer 预览；发送仍优先使用本地路径引用。
- 非图片附件显示同等的文本状态；失败态提供重试和删除。
- 状态不只依赖颜色，必须提供本地化的 `aria-label` / `role=status|alert`。
- V4 的文件 drop 由整个对话 pane 根节点唯一接管：时间线、空态、状态区和 composer 都处于同一 drop surface；主输入框不再重复注册文件 drop。桌面新建任务的轻量标题栏在窗口级 drag 状态激活后显示临时 drop mask，并接到主草稿 composer。这一结构与旧版 `ChatView` 一致。
- 工作区文件树的 `WORKSPACE_FILE_DRAG_MIME` 不作为上传附件，而是插入工作区文件 mention；操作系统文件才进入附件预传队列。该语义与旧版 `ChatView` 一致。
- 手机 Web 没有系统文件拖拽/选择器入口；本次只复用 V4 composer 的 renderer 本地 drop 路由，不新增 runtime、host、relay 或 `web-remote-replayable` 传输语义。
- 编辑已发送 query 或排队消息时（composer 编辑态，见 [Composer 编辑态](composer-edit-mode.md)），附件能力与普通 composer 完全一致：
  可删除既有附件，也可选择、拖入、粘贴新增附件，长粘贴同样转为文本附件。既有附件是 session-owned ref，不重新上传。
- Excel/表格软件复制单元格时，系统剪贴板可能同时暴露 `text/plain`、Excel HTML 和合成
  `image/png`。普通 composer 检测到 Excel HTML 标记或制表符分隔文本时必须优先走文本：
  短内容交给编辑器粘贴，达到 5120 字符才转 clipboard-text 附件；不得把同一 payload 的
  合成 PNG 当成用户主动粘贴的图片。没有表格文本证据的截图、图片复制和 `.xlsx` 文件仍走附件。

## 已发送 Query 的附件编辑

```text
row.attachments
  -> 打开 edit 时复制为 renderer-local editAttachments
       -> 删除一个或多个 ref
          -> accepted: editUserQuery.attachments 原样替换 active branch
          -> failed/stale/blocked: 保留本地编辑状态
          -> cancel: 丢弃本地状态，下次从 row 重新初始化
```

`editUserQuery.attachments` 的三态合同：字段缺省表示保留 canonical 原附件；非空数组表示
按给定顺序替换；显式 `[]` 表示清空全部附件。删除已发送附件不调用 attachment transfer、abort
或 cleanup API，避免破坏旧历史与其他 branch 的引用。

## 已发送图片预览

已发送 user row 继续只保存 `AttachmentRef`。图片附件（`mime` 以 `image/` 开头）可点击；
非图片附件保持静态，不提供 button、手型光标或键盘打开语义。renderer 不把发送前的 `File`、
object URL 或 base64 当作历史事实，live、cold resume 和 app restart 都从当前 row ref 走同一条
只读查询。

```text
ConversationRow.userInput.attachments
  -> 图片点击
     -> workspace service（沿当前 workspaceIdentity / remoteSessionId attachment）
        -> v4/attachment/read(sessionId, previewRef ?? ref, offset, limit)
           -> CLI 先验证 ref 属于当前 session 的图片 row
              -> zcode-artifact:// ref：读取持久化 artifact
              -> local / SSH / WSL / Docker path：由该 session 所在 runtime 读取
           -> <= 512 KiB decoded chunk，NDJSON 返回 base64
        -> renderer 拼成 Blob URL -> 图片预览 dialog
        -> close / target change / unmount -> URL.revokeObjectURL
```

```text
desktop-continuous row -------------------+
                                          +-> 同一个只读 attachment/read query
web-remote-replayable row -> attached host+

relay / desktop main：只转发，不保存 bytes、cache、row 或 preview 状态
```

- query 必须带精确 `sessionId`，CLI 只接受该 session 当前投影中图片附件的 `ref` 或
  `previewRef`；禁止把任意 renderer 路径变成文件读取接口。
- wire 每次最多返回 512 KiB decoded bytes；UI 高层 transport 负责按 `nextOffset` 拉完，避免
  20MiB 附件突破 1MiB NDJSON envelope。CLI 可做短时、有界的同 ref 读取缓存，但不得持久化到
  relay/main，也不得进入 conversation snapshot/event。
- 读取失败时 dialog 显示本地化的“图片不可预览”，保留文件名以解释历史；该卡片随后移除
  打开语义与假手型。失败不会修改 row、branch、provider context 或附件文件。
- 手机 `/remote` 不新增独立 Agent runtime；它通过 shared-host attachment 访问桌面窗口已经
  存在的 local/remote workspace session host。远端身份隔离仍统一使用
  `workspaceIdentity?.trim() || workspacePath`，路径执行仍使用 `workspacePath`/runtime ref。
- 旧历史没有可读 ref、文件已移动/删除或 artifact 已回收时不尝试猜路径，也不回退把 base64
  塞进 row；明确进入不可预览状态。

```text
文件拖入 pane / 桌面草稿标题栏
  -> 目标 SessionPane 的 ConversationComposer drop controller
       -> workspace-file MIME -> 插入 mention
       -> OS File[]           -> 附件预传（原有 V4 路由）

主输入框不单独注册 drop
  -> 同一事件只由外层 SessionPane 消费一次
```

实现入口：`packages/ui/src/v4/ConversationComposer.tsx` 和
`packages/ui/src/v4/composer/useComposerAttachments.ts`。
