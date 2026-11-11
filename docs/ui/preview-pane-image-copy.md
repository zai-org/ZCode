# 右侧图片预览操作

## 下载与添加到聊天（2026-10-14）

用户确认：「添加到聊天」沿用文件树的文件引用方式，加入当前输入框，不自动发送。本轮覆盖空草稿、已有草稿和工作区隔离；发送、排队、fork、rewind 的状态组合不在本次扩展范围。

- 图片区域右键菜单提供「添加到聊天」「复制图片」「下载图片」。窄屏通过「图片操作」按钮展开同样的菜单，避免依赖右键和横向堆放按钮。
- 下载复用全屏图片预览的有界下载与 `IPlatformService.saveFile`；桌面使用另存为，取消不提示错误，Web 使用浏览器下载。保存原始字节和图片格式（PNG/JPEG/WebP/SVG 等），不把 SVG 下载成截图，也不改变复制 PNG 的既有语义。
- 原生保存成功只提示「下载成功」，不展示文件路径；全屏图片预览使用相同简短提示。浏览器尚未确认落盘时仍提示「图片下载已开始」，取消保存不提示。
- 添加到聊天复用 `dispatchWorkspaceFileAddToChat`，由当前 focused Composer 追加文件 mention 并聚焦；保留已有文本和附件，不产生 user message、上传或 Agent 请求。
- 添加成功后菜单（右键菜单与窄屏「图片操作」菜单）关闭时不把焦点还给图片预览区，焦点留在 Composer；复制、下载和添加失败时仍按菜单默认行为回到预览区。
- 文件引用必须有真实 source path、workspacePath。只有图片路径确实位于来源工作区内时才生成相对引用；工作区外图片即使与工作区内文件同名，也保留绝对路径。本地文件在未绑定或不同本地工作区的草稿中使用绝对引用。涉及远程 Host 时必须匹配 `workspaceIdentity?.trim() || workspacePath`；远程 identity 不同或没有来源路径时禁用引用入口，不把远端 path 当作本地 path 插入。
- 下载扩展名覆盖预览支持的 PNG/JPEG/APNG/AVIF/BMP/GIF/ICO/SVG/WebP。MIME 未知时保留可信来源文件名的图片扩展名；已知 MIME 优先保证扩展名与格式一致。
- 有来源路径的 SVG 下载在点击时通过已匹配来源工作区的文件服务有界读取原字节，不使用文本预览重新编码后的 data URL。无来源文件的内联 SVG 才按当前内联内容下载。
- PreviewPane 沿既有 source scope 读取内容，引用只改变当前 Composer 的 renderer draft；不改变 `remoteSessionId`、shared-host attachment、continuous/replayable 恢复语义。
- 图片未加载或当前图片操作未结束时，禁用复制/下载；没有可接收的 Composer 时，添加引用明确提示失败。

```text
文件 SVG 路径 → 来源 workspace 的 fileService 原字节读取 ─┐
其他图片/内联 SVG 原字节 ──────────────────────────────┴→ 共享有界下载 → Desktop saveFile / Web download
当前图片路径 + workspaceKey → 匹配 focused Composer → 原有文件引用事件
                                                   └─ 追加到草稿，不发送
```

新增验收：PIA01 原格式下载与取消；PIA02 空草稿/已有草稿的文件引用与附件保留；PIA03 同路径不同 workspace identity 拒绝串用；PIA04 手机宽度、中英文、双主题菜单可达。桌面候选与文件夹具保留在 `conversation-session/manual-review/pending`；真机手机、真实 SSH/WSL/Docker 与 Windows/Linux 原生另存为未执行时必须明确标注。

Review 回归：PIA01 加入 APNG/BMP/ICO 的扩展名与原字节比较，以及带 ISO-8859-1 声明的非 UTF-8 SVG；PIA03 加入工作区内外同名图片，检查文件引用事件消费后的 canonical mention 保留外部图片绝对路径。原有桌面 PIA02 继续核对实际 Composer 的草稿保留与零发送。沿用已确认的草稿/下载语义，不增加发送或会话状态组合。

## 行为

- 右侧预览中的普通图片和 SVG 渲染结果提供「复制图片」右键菜单。
- 桌面可聚焦预览区使用键盘菜单；窄屏显示有文字标签的「图片操作」菜单按钮，避免依赖鼠标右键。
- 复制写入当前客户端的系统剪贴板，格式为 PNG，保留图片自然尺寸和透明度；SVG、JPEG 等先栅格化，复制的是图片而非路径、源码或带棋盘背景的截图。
- 图片加载完成前和复制执行期间禁用入口。复制完成显示成功提示；解码、剪贴板权限或 API 不可用时明确提示失败，不误报成功。
- 复用现有菜单、按钮、toast、主题 token 和中英文翻译；不改变预览布局、Retina 显示规则和 SVG 源码切换。

## 边界与时序

```text
当前预览图片 → 用户右键/按钮 → 立即提交 ClipboardItem(Promise<PNG>)
                                  └─ 当前 img 自然像素 → canvas → PNG
系统剪贴板写入完成 → 成功提示；任一步拒绝 → 失败提示
```

PNG 转换必须在用户操作内立即创建并提交 promise，避免异步转换先消耗 Safari 的用户激活权限。组件仅拥有本次复制的 pending 状态，不增加服务层或主进程业务状态。

远程文件沿用既有文件读取和预览数据链路，复制发生在查看图片的客户端；不引入 Agent 请求，不修改 workspaceIdentity、desktop continuous 或 web remote replayable 的恢复边界。不扩展到全屏会话图片画廊。

## 验证用例

| 编号   | 前提与动作                   | 断言                                   |
| ------ | ---------------------------- | -------------------------------------- |
| PIC-01 | PNG 加载后右键复制           | 原生剪贴板为图片，像素尺寸与原图一致   |
| PIC-02 | SVG 预览后右键复制           | 原生剪贴板为 PNG，复制后可粘贴为图片   |
| PIC-03 | 窄屏打开图片操作并选择复制   | 与右键路径相同，无横向溢出             |
| PIC-04 | 加载中、解码失败或剪贴板拒绝 | 入口禁用或明确失败，不显示成功         |
| PIC-05 | 深浅主题、中英文、键盘菜单   | 文字可见、菜单可操作，预览布局保持不变 |

E2E 候选：`packages/desktop/test/e2e/ui-shell/panels/preview-pane-image-copy.test.ts`。此用例只经过文件树和图片预览，不改变会话状态；人工审阅前保留 pending 状态。

## 验证记录（2026-10-14）

### Review 修复验证

- 首次 review 的 CR-01/02/03 已修复：外部图片保留绝对引用、预览支持格式保留正确扩展名、文件 SVG 通过来源文件服务下载原始字节。
- 新增回归先复现失败：工作区外路径、格式扩展名单测失败；真实桌面 APNG 默认保存名错误。修复后 135 个受影响单测文件、2303 项通过。
- 扩展后的 macOS Electron 候选 2/2 通过（`desktop-e2e-20261014073357957-p93626-1fd083e49fa01cc4`）：PNG/APNG/BMP/ICO、UTF-8/ISO-8859-1 SVG 的保存字节与默认文件名、取消、草稿/附件保留和零发送。
- 浏览器 9/9 通过：原 8 组桌面/手机宽度、深浅主题、中英文交互，以及工作区外同名图片的绝对引用事件链。
- 根 typecheck、桌面 typecheck:e2e、lint、architecture 与候选 fixture 检查通过；lint 仍为 210 条既有 warnings。平台验证限制与下节相同。

### 成功提示精简验证

- 原生另存为完成后只显示「下载成功」/「Download complete」，提示中不再包含路径。独立 Electron 窗口已实际下载并核对简短提示及文件字节。
- 最终回归：501 个受影响单测文件、5417 项通过；桌面候选 2/2（`desktop-e2e-20261014080901855-p14519-20731221317b237a`）、浏览器 9/9 通过；typecheck、lint、architecture 通过。

### 下载与文件引用追加验证

- macOS 桌面：`conversation-session-preview-image-actions` 最终 2/2 通过，run `desktop-e2e-20261014070220038-p64953-d881563a059ec2b4`。验证 PNG/SVG 原字节保存、取消、空/非空草稿、焦点、原附件保留和零模型请求。
- 浏览器：`node --test packages/ui/test/browser/manual-review/pending/preview-image-actions.test.mjs`，390/1100px × Light/Dark × 中英文，共 8/8 通过；每组实际执行复制、下载、添加引用。
- 工作区引用与组件事件、原格式下载由 focused unit 验证；E2E 启动夹具的 41 项回归通过。候选仍等待人工晋级，不声称 Docker 准入。
- 最终受影响回归 504 个文件、5447 项通过；根 typecheck、桌面 typecheck:e2e、lint、architecture 检查及候选 fixture 校验通过。功能图已有 4 条悬空边，本次新增 0 条，新增 code seeds 校验通过。
- 追加功能未验证 Windows/Linux 原生另存为、手机 Safari 真机或真实远端 Host。

### 首版复制验证

- macOS Electron：从真实工作区文件树打开 SVG/PNG，右键复制并读取原生剪贴板尺寸，验证键盘 Shift+F10 菜单；1 个 E2E 用例通过。
- Chrome：390×844 触屏视口下深浅主题、中英文按钮复制均通过；720×440 SVG 输出为同尺寸 PNG；Retina PNG 输出保留 64×48 原始像素和透明区域；剪贴板拒绝时只有失败提示。
- `pnpm test:unit:affected --base <变更基线>`：499 个文件、5387 项通过；包含本功能 7 项单测。
- `pnpm typecheck`、桌面 `typecheck:e2e`、`pnpm lint`、`pnpm architecture:check --changed` 均通过。lint 存在仓库原有 warning。
- Windows、Linux 原生剪贴板及手机 Safari 真机未执行；触屏验证为浏览器模拟视口，不代表真机或远程 host 全链路验收。

候选 E2E 使用公共 replay 夹具启动环境，不产生模型请求：

```sh
ZCODE_E2E_MANUAL_REVIEW=1 \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
pnpm --filter @zcode/desktop test:e2e -- \
  --spec './test/e2e/ui-shell/panels/preview-pane-image-copy.test.ts'
```
