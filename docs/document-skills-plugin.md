# 文档类官方插件

原 `document-skills` 按格式拆为四个独立内容插件，并内置独立 `image-search` 搜图插件，随客户端默认启用：

| 插件          | Skill | 源码目录                                       |
| ------------- | ----- | ---------------------------------------------- |
| documents     | docx  | `apps/zcode-cli/packages/documents-plugin`     |
| pdf           | pdf   | `apps/zcode-cli/packages/pdf-plugin`           |
| presentations | pptx  | `apps/zcode-cli/packages/presentations-plugin` |
| spreadsheets  | xlsx  | `apps/zcode-cli/packages/spreadsheets-plugin`  |

同步来源为内部插件仓库 `zcode-marketplace/zcode-plugins-test`，
`origin/main` 提交 `e19dca8be86cf981ed2e0c2b4855c6ee6ee15265` 的对应 `plugins/<插件名>` 目录。
四个内置发布版本均为 `0.1.8`（高于旧聚合插件 `0.1.5`）。导入目录逐字节对齐上游，
仅允许 package.json 与 .zcode-plugin/plugin.json 的内置版本字段差异；本次内容差异均来自上游导出，版本字段按内置发布序列升版。

许可证：四个文档插件与搜图插件均为 Apache-2.0（2026-10-08 起，文档插件原为非商业许可，随开源改为 Apache-2.0，0.1.8 起生效；上游插件仓库需同步修改许可，否则下次同步会把旧许可带回）。

展示名对应：Documents / Word文档、Presentations / 演示文档、PDF / PDF、Spreadsheets / 电子表格、Image Search / 搜图。

## 发现、启用与升级

Bootstrap 官方 definition 是内置目录与默认启用的权威来源；Settings 默认名单须与其一致。
启动 → seed 四个独立缓存 → 重建内置市场分片 → 既有插件发现读取分片 → 暴露 skills/agents。
缓存分别为 `~/.zcode/cli/plugins/cache/zcode-plugins-official/<插件名>/0.1.8/`。
每个插件可以独立启停、卸载与恢复，不再发布内置 `document-skills` 条目。
旧聚合插件缓存和用户配置不删除；重建后的内置分片不再引用旧目录。
用户另行安装的市场插件仍按既有安装与启用配置处理，不自动改写或卸载。

每个插件提供 `agents/visual-judge.md`，使用 `<插件名>:visual-judge` 限定名。
当前内置子代理按插件区分身份色：documents 使用 blue，pdf 使用 red，presentations 使用 purple，spreadsheets 使用 green；颜色只修改各自 agent frontmatter，不改变代理名称、模型或权限。对应版本为 documents/presentations/spreadsheets 0.2.2、pdf 0.2.3，以新的版本缓存发布；Bootstrap definition、package 与插件 manifest 同步升版。上述 0.1.8 是初次拆分的导入记录，后续版本以 definition 与各插件 manifest 为准。
原 `judge` 名称不再由内置插件提供。每个插件只携带自己的格式 skill；四个插件本身不再声明
`image_search` MCP，图片搜索由默认启用的 `image-search` 插件提供，版本为 `0.1.1`，通过既有官方 JWT 认证访问 `${ZCODE_BASE_URL}/api/v1/mcp/server/image_search`；不新增本地 MCP runtime。
`image-search` 缓存路径为 `~/.zcode/cli/plugins/cache/zcode-plugins-official/image-search/0.1.1/`。

## 打包与验收

filesystem seed、SEA、Electron Node bundle、remote prebuild、server remote 部署与容器评测
必须使用五个目录，保留 `agents/`。每个发布单元必须校验自己的 `skills/<格式>/SKILL.md`
与 `agents/visual-judge.md`；缺少任意必需资产不得标记成完整缓存。
所有版本权威（package、manifest、Bootstrap、SEA）与缓存路径必须一致，内容变化必须升版。

验收覆盖：四个插件默认发现且可独立关闭；旧聚合条目不再内置；四类技能与限定 Agent 名称
分别可发现；filesystem/SEA 完整性拒绝缺失评审 Agent；桌面与远端打包清单不遗漏任何一个插件。
本次只变更插件内容与分发清单，不改动桌面 continuous 或手机 replayable 会话语义。

## 依赖边界

内置 skill 不等于内置系统依赖。LibreOffice、Poppler、Playwright、ReportLab、Tectonic、
python-pptx、openpyxl 等由运行环境提供或按上游 skill 的环境检查安装。
脚本相对路径以 Skill 工具返回的 base directory 为准。
