# 设计

这个插件帮助 Agent 做设计：把需求变成写入工作区的 HTML 设计稿、可交互原型或 HTML 演示稿，并在交付前自己检查。

- **`design` 技能** 是唯一入口：先判断是新建、改版、配色、视觉审查请求，再按需读取规则与设计资源。
- 设计资源随插件提供：74 套设计骨架（含 HTML 演示稿模板）、23 套设计系统风格参考、11 篇 craft 规范，以及无限画布、前端演示稿等子技能。

## 使用

`design` 随 ZCode 内置、默认启用（可以停用，不能卸载），可以这样说：

- “给一款记账 App 做一个落地页，保存到 原型/。”
- “按这张截图改版设置页，给我一稿。”
- “做一份 8 页的产品发布 HTML 演示稿。”
- “帮我审一下 原型/pricing.html 的视觉层级和可访问性。”
- “从这个仓库导入设计系统，再用它做账单页。”
- “用 design-system/harbor.md 检查 原型/pricing.html。”

设计稿写入工作区（默认 `原型/` 目录）后，回复里会出现 HTML 预览卡；在桌面端本地工作区点击即可在内置浏览器侧栏查看，切换尺寸、缩放、选中元素加入对话。设计稿能从 `file://` 直接打开，并带 `data-zcode-design` 标记；宿主没有设计模式时，在任意浏览器里打开，在对话里用文字描述修改。

## 设计系统

技能可以把设计稿绑定到一份设计系统文件：颜色、字体、间距、圆角 token 加简短使用说明，存在工作区 `design-system/<名字>.md`，可多套并存。`scripts/import-design-system.mjs` 从项目的 CSS 变量、Tailwind 配置（只按文本解析，从不执行）和已有 HTML 页面生成；图片或文档类来源由 Agent 阅读后按同一格式手写。交付前 `scripts/design-lint.mjs` 把页面里不出自 token 的颜色、字体和（可选）间距逐条列出，带文件、行号和最接近的 token。

## 与其他插件的分工

| 你要的产物                             | 插件          |
| -------------------------------------- | ------------- |
| 落盘的 HTML 设计稿、原型、HTML 演示稿 | design        |
| 对话内的交互视图、mockup、变体对比     | visualize     |
| `.pptx` 文件                           | presentations |

需要 pptx 时，design 会交给 presentations 插件生成。

## 组件

| 组件     | 类型 | 用途                                                       |
| -------- | ---- | ---------------------------------------------------------- |
| `design` | 技能 | 设计工作流入口：输入理解、新建与改版、视觉探索、审查与交付 |

## 网络、文件与副作用

- **文件写入**：设计稿、原型和演示稿写入当前工作区，默认目录 `原型/`；改版时保留旧版本文件。
- **命令执行**：三个 Node 脚本经 Bash 运行，都不安装依赖：无限画布适配脚本 `scripts/adapt-canvas.mjs` 写出一个新的工作区文件；`scripts/import-design-system.mjs` 读工作区的 CSS、Tailwind 配置与 HTML（跳过点目录、`node_modules` 与构建产物），写 `design-system/<名字>.md`，不覆盖已有文件；`scripts/design-lint.mjs` 只读。
- **网络**：插件本身不发请求。交付的设计稿自包含，不依赖外链资源；设计骨架示例引用 Google Fonts、gstatic 与 jsdelivr 的字体和脚本，打开示例时由浏览器加载，离线时降级为系统字体。
- **依赖其他插件（可选）**：浏览器验收使用任一可用的浏览器或截图工具（例如 browser-use 插件），搜图使用 image-search 插件，导出 pptx 使用 presentations 插件。
- **生图**：本版本不包含，二期在生图服务的账号鉴权打通后接入。
- **会话上下文**：SessionStart hook（`hooks/design-rules`，POSIX sh，不需要 Node）在插件启用期间每个会话往模型上下文加一句话：做 HTML 设计稿、原型、HTML 演示稿或改版时先加载 `design` 技能，并给出技能目录（约 110 字节加路径）。工作流正文只在技能加载时读取。
- 无命令。

## 来源与许可

本插件代码以 Apache-2.0 发布。设计资源包含第三方开源内容，许可原文随包保留：

- 设计骨架与资源主体衍生自 open-design 项目，MIT（`skills/design/design-resources/LICENSE.md`、`NOTICE.md`）。
- HTML 演示稿系列模板，MIT（各骨架目录下的 `LICENSE` 与 `design-resources/LICENSE-html-ppt`）。
- 部分子技能自带 Apache-2.0 等许可，见各子技能目录。
- 设计系统以第三方品牌作为风格参考，不代表与相关品牌存在关联，见 `design-resources/design-systems/BRAND-DISCLAIMER.md`。
