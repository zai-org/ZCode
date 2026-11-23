# 文档类官方插件

原 `document-skills` 按格式拆为四个独立内容插件，并内置独立 `image-search` 搜图插件，随客户端默认启用：

| 插件          | Skill | 源码目录                                       |
| ------------- | ----- | ---------------------------------------------- |
| documents     | docx  | `apps/zcode-cli/packages/documents-plugin`     |
| pdf           | pdf   | `apps/zcode-cli/packages/pdf-plugin`           |
| presentations | pptx  | `apps/zcode-cli/packages/presentations-plugin` |
| spreadsheets  | xlsx  | `apps/zcode-cli/packages/spreadsheets-plugin`  |

## 来源

2026-10-29 起，四个文档插件以本仓库为唯一事实源：插件改动直接在本仓库完成，并按版本规则升版，不再先改插件主仓库再导入。

此前的生产内容来自插件主仓库，LibreOffice 增量最后一次导入自本地上游 commit `583d3759112d8350d93f58cb4848600da590d6b5`（TREE `970a9044e75d27355913f5cf01b1a43b8cfc70b6`）。来源及 63 项逐文件记录见 [08-source-import.json](issues/document-tool-preinstall/08-source-import.json)，仅作历史记录。

查看器产物仍由本仓库 [office-runtime](../apps/zcode-cli/packages/office-runtime/CONTRACT.md) 构建，遵循 [内置查看面板规格](plugins/2026-10-15-office-viewer-builtin-panels-spec.md)。

非受管环境保留已有的程序发现与安装语义；系统程序不设最低版本门槛。

当前版本：documents、presentations、spreadsheets 为 `0.2.10`，pdf 为 `0.2.11`。这一版起不再提供视觉验收子代理（见下文），内容与此前的 `0.2.9`、`0.2.10` 不同，因此再升一版；新版本换新缓存目录，老用户升级后也不再加载旧缓存里的子代理。系统程序保留符号链接调用名，避免多入口分派失效。

许可证：四个文档插件与搜图插件均为 Apache-2.0。本次保留既有许可文件，不从旧上游导入不同授权文本，也不改变任何许可授予。

展示名对应：Documents / Word文档、Presentations / 演示文档、PDF / PDF、Spreadsheets / 电子表格、Image Search / 搜图。

## 发现、启用与升级

Bootstrap 官方 definition 是内置目录与默认启用的权威来源；Settings 默认名单须与其一致。
启动 → seed 四个独立缓存 → 重建内置市场分片 → 既有插件发现读取分片 → 暴露 skills 与查看面板。
缓存分别为 `~/.zcode/cli/plugins/cache/zcode-plugins-official/<插件名>/<该插件版本>/`，版本取 package/manifest 与 Bootstrap 的一致声明。
每个插件可以独立启停、卸载与恢复，不再发布内置 `document-skills` 条目。
旧聚合插件缓存和用户配置不删除；重建后的内置分片不再引用旧目录。
用户另行安装的市场插件仍按既有安装与启用配置处理，不自动改写或卸载。

四个插件不提供子代理：自 documents/presentations/spreadsheets `0.2.10`、pdf `0.2.11` 起删除
`agents/visual-judge.md`，manifest 不再声明 `agents`，Settings 子智能体列表中不再出现
`<插件名>:visual-judge`。生成文档时不派子代理做视觉验收；需要视觉检查时，Agent 把产物渲染成图片后
自己看图检查一次，不调用外部 VLM。不提供插件子代理的单独开关。
原 `judge` 名称同样不再提供。每个插件只携带自己的格式 skill；四个插件本身不再声明
`image_search` MCP，图片搜索由默认启用的 `image-search` 插件提供，版本为 `0.1.1`，通过既有官方 JWT 认证访问 `${ZCODE_BASE_URL}/api/v1/mcp/server/image_search`；不新增本地 MCP runtime。
`image-search` 缓存路径为 `~/.zcode/cli/plugins/cache/zcode-plugins-official/image-search/0.1.1/`。

## 打包与验收

filesystem seed、SEA、Electron Node bundle、remote prebuild、server remote 部署与容器评测
必须使用五个目录。四个文档插件还须保留 `scripts/zcode_libreoffice.py` 和完整 `scripts/libreoffice-profile/`；四份内容必须逐字节一致，由工程门禁检查。每个发布单元必须校验自己的 `skills/<格式>/SKILL.md`
与 `skills/<格式>-viewer/SKILL.md`；缺少任意必需资产不得标记成完整缓存。四个文档插件不再携带 `agents/`，也不再把子代理文件列为必需资产。
所有版本权威（package、manifest、Bootstrap、SEA）与缓存路径必须一致，内容变化必须升版。

验收覆盖：四个插件默认发现且可独立关闭；旧聚合条目不再内置；四类技能分别可发现；
Settings 子智能体列表不出现四个 `<插件名>:visual-judge`；filesystem/SEA 完整性拒绝缺失技能或面板资产；
桌面与远端打包清单不遗漏任何一个插件。
本次只变更插件内容与分发清单，不改动桌面 continuous 或手机 replayable 会话语义。

## 依赖边界

内置 Skill 和查看面板可用，不表示文档转换与重算环境已经就绪。

2026-10-29 起的合同见 [预装工具](preinstalled-tools/README.md)，下文是插件侧的摘要。预装链路和插件调用已实现；正式 catalog 的资源发布与部分平台验收仍未完成，尚未向用户交付完整预装环境。

本机桌面预装五个工具：Python（含插件主流程使用的包）、qpdf、Pandoc、Poppler、LibreOffice。插件不替换依赖的工具和库，只改“去哪里找工具”和缺失时的引导：

| 工具                  | 插件调用方式                                                                                                                     | 未就绪或开关关闭时               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Poppler、Pandoc、qpdf | 原命令名，例如 `pdftoppm`。预装入口排在 Agent PATH 最前                                                                          | 找到用户自己装的程序             |
| Python                | 先找 `zcode-python`，找不到再用 `python3`；运行脚本和安装包都这样写，见 [Python 规格](preinstalled-tools/python.md#插件调用规则) | 落到用户的 `python3`             |
| LibreOffice           | 统一入口 `scripts/zcode_libreoffice.py`，它先找 `zcode-soffice`                                                                  | 使用系统版本（不限版本，含 Dev） |

- 预装 Python 下安装的包写进它的附加区，不改动预装包。安装失败或预装 Python 无法运行时，Agent 先说明原因，再由用户选择是否改用自己的 Python。
- LibreOffice 预装版本启动或运行失败时，统一入口先清理，再用系统版本重跑一次；系统失败直接报告，取消不重跑。每次调用使用独立 profile；重算使用本次的宏回执；不修改用户默认配置。
- 工具都不可用时（五个工具一致）：有 `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` 的桌面端先说明预装版本未就绪或已关闭，提示“帮助 → 预装工具”，由用户选择等待、打开开关，或按插件原有方式继续（例如按 setup.md 安装）；其他环境保持原有安装引导。
- 不预装：Node.js 与 npm 包、tectonic、Chromium、Ghostscript、tesseract、pytesseract、markitdown、adjustText、PyMuPDF。它们仍按插件已有的环境检查和安装说明处理。
- Web 服务端、独立 CLI、容器和远端环境没有入口目录和变量，行为与现在相同。预装只在本机，不部署到 SSH、WSL、Docker 或其他远端工作区。

脚本相对路径以 Skill 工具返回的 base directory 为准。四个格式 Skill 位于 `skills/<格式>/`，统一入口从该目录定位为 `../../scripts/zcode_libreoffice.py`，配置模板位于同一脚本目录下的 `libreoffice-profile/`。
