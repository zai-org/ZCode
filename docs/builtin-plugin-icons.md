# 内置插件图标

内置插件的商店信息定义在
`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`。每个
`listing.icon` 使用官方插件资源 CDN：

```
https://cdn-zcode.z.ai/zcode/official-plugin/assets/<plugin-name>/icon.png
```

例外：部分官方插件的图标随客户端打包，不走 CDN——`packages/ui/src/lib/pluginIconSource.ts` 的
`OFFICIAL_PLUGIN_ICON_BY_ID` 按完整 stable ID 命中 `packages/ui/src/assets/plugin-icons/<name>.png`
（目前是插件创建器、PDF、文档、演示文稿、电子表格、图片搜索、设计、Visualize）。内置「设计」插件
（`design@zcode-plugins-official`）没有 `listing.icon`、CDN 上也没有 `design/icon.png`，只靠这里的本地资源（2026-11-06）。

Visualize（`visualize@zcode-plugins-official`）使用本地 `visualize.png`：蓝青色圆角柱形与上升曲线，图片自带不透明浅蓝背景，外层圆角仍由共用容器裁切。
商店列表、详情和其他共用图标入口按完整官方身份使用同一资源；个人来源的同名插件不匹配。
保持现有图标尺寸与容器，深浅主题均保留原图颜色，不反相。验收在 390px / 1200px、
Zai Light / Zai Dark 下检查图片加载、详情图标及小尺寸识别度。

`computer-use` 复用已发布的 `assets/zcode-cua/icon.png`。插件标识从 `zcode-cua`
改为 `computer-use` 后，CDN 资源目录仍保留原名；不能随插件标识拼接出尚未发布的
`computer-use/icon.png`（会返回 404）。图标路径与插件标识可以独立维护。

资源文件由 `zcode-plugins` 仓库的 `assets/<plugin-name>/icon.png` 提供；该仓库的
`main` 分支发布流水线会将 assets 目录同步到 CDN。图标使用 HTTPS URL，以符合客户端
受信任图片地址校验。PNG 必须使用透明背景，并保留 Figma 原始颜色；商店使用语义化
`bg-hover` 容器承载图标，不再对整张图片做深色主题反相，避免 Android、iOS、ZCode
等品牌色在深色主题失真。Installed Strip 也不得根据插件启用状态对头像整体应用透明度；
启用状态由管理视图表达。若资源请求失败或没有配置图标，插件商店会继续显示默认图标。

Figma 节点 `5080:5352` 的 Installed Strip 定义了内置图标的视觉契约：36px 圆角容器
内居中放置 24px 图形。内置插件定义顺序与图标顺序必须保持一致：

1. `android-emulator` → `android`
2. `document-skills` → `dotpoints-01`
3. `ios-simulator` → `ios`
4. `restore-legacy-sessions` → `Frame`（归档盒上箭头）
5. `skill-creator` → `Frame`（立方体）
6. `zcode-guide` → ZCode 标志
7. `design` → 不在该 Figma 节点里（例外）：图形是设计同学单独给的色卡图，随客户端打包在
   `packages/ui/src/assets/plugin-icons/design.png`，见上文「随客户端打包」的例外

Installed Strip 排序时，内置/inline 插件必须整体排在市场安装插件之前，并按当前语言
下的展示名称稳定排序；其余市场安装插件继续按安装时间倒序。排序依据使用运行时
`source`，不以是否缺失 `installedAt` 间接判断内置身份。

当前内置插件：`android-emulator`、`document-skills`、`ios-simulator`、
`restore-legacy-sessions`、`skill-creator`、`zcode-guide`、`design`（图标为客户端本地资源，见上文例外）。
