import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

// 内置插件的商店信息 seed（原样写入官方 marketplace.json 的条目 raw，键名与 CDN 目录
// schema 一致：displayName_i18n / examplePrompts_i18n 等），解析复用 adapter 的
// parseEntryStoreListing。icon 指向官方 assets CDN；请求失败时 UI 会安全降级为默认图标。
export interface OfficialPluginListingSeed {
  displayName?: string;
  displayName_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  category?: string;
  author?: { name: string; url?: string };
  icon?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  heroImage?: string;
  examplePrompts?: string[];
  examplePrompts_i18n?: Record<string, string[]>;
}

export const OFFICIAL_BROWSER_USE_PLUGIN_NAME = "browser-use";
export const OFFICIAL_BROWSER_USE_PLUGIN_ID = `${OFFICIAL_BROWSER_USE_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
export const OFFICIAL_VISUALIZE_PLUGIN_ID = `visualize@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
/**
 * node_repl 宿主。它不是面向用户的插件：没有 skill、没有 listing、不进市场，唯一职责是
 * 携带 `dist/mcp/server.js` 这个 Browser Use 与 Computer Use 共用的运行时产物。
 *
 * 为什么它需要成为一个 seed 单元：宿主产物过去长在 browser-use 包里，于是
 * resolveBuiltInNodeReplMcpServers 只能在 browser-use 的 rootPath 下找它 —— browser-use
 * 包缺失时，即便 Computer Use 自己启用也拿不到宿主。做成独立 seed 单元后，两个插件
 * 各自只贡献自己的领域资产，谁启用都能拿到同一个宿主。
 */
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME = "node-repl-host";
export const OFFICIAL_NODE_REPL_HOST_PLUGIN_ID = `${OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
export const OFFICIAL_CUA_PLUGIN_NAME = "computer-use";
export const OFFICIAL_CUA_PLUGIN_ID = `${OFFICIAL_CUA_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

export interface OfficialPluginDefinition {
  /**
   * 卸载（抑制）后的可恢复条目没有运行时信息，商店只能靠这里判断是否归入「UI 插件」。
   * 插件包 manifest 声明 ui.surfaces 时必须同时声明 "ui"，由 bootstrap 测试校验一致。
   */
  componentTypes?: readonly string[];
  // 内容型 plugin (无 MCP server / 无系统依赖) 可以设为 true,
  // 这样用户首次 `/skill <name>` 就能用,不必先 `zcode plugins enable`。
  // 默认 false 保持 ios-simulator / android-emulator 这类重负载 plugin 原来行为。
  defaultEnabled?: boolean;
  listing?: OfficialPluginListingSeed;
  /**
   * 由宿主为该官方插件提供、但不属于 plugin manifest 的 MCP server。
   * 仅用于产品归属和设置页状态展示；运行时仍保留宿主 identity。
   */
  hostMcpServerNames?: readonly string[];
  /**
   * 构建产物内嵌每次构建不同、但不改版本号的值时，指向构建脚本写出的身份文件。
   * seed 把文件内容记入 marker，内容变化按版本变化处理。
   */
  buildIdentityPath?: string;
  name: string;
  /** filesystem/SEA seed 缺少任一项时拒绝生成残缺的官方插件缓存。 */
  requiredSeedPaths?: readonly string[];
  rootCandidates: readonly string[];
  /** Extra top-level paths intentionally staged as plugin runtime assets. */
  runtimeTopLevelPaths?: readonly string[];
  version: string;
}

const ZAI_AUTHOR = { name: "Z.ai", url: "https://z.ai" } as const;
const OFFICIAL_PLUGIN_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets";

export const OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS = ["dist/mcp/server.js"] as const;
const NODE_REPL_HOST_BUILD_IDENTITY_PATH = "dist/build-identity.json";

/** 文档插件（documents / pdf / presentations / spreadsheets）查看面板的构建产物。 */
export const OFFICIAL_OFFICE_VIEWER_RUNTIME_PATHS = [
  "dist/server.mjs",
  "dist/ui/assets.json",
  "dist/ui/panel.html",
] as const;

export const OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS = [
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json 已注册 recording lookup；若不强制校验正文，会 seed 出无法读取录屏指南的残缺插件。
  "docs/recording.md",
  "docs/workflow.md",
  "scripts/browser-client.mjs",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
] as const;

export const OFFICIAL_CUA_REQUIRED_SEED_PATHS = [
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
] as const;

// 修复原因（2026-08-24）：zcode-guide 原本没有 requiredSeedPaths，seed 丢文件时会静默装出一个
// 残缺插件而没有任何诊断。0.3.0 起 `/workflow` 与 dynamic-workflows 技能不再随本插件发布
// （命令编进 CLI，技能进 packages/bundled-skills，见 docs/dynamic-workflow/authoring.md），
// 这里钉住的是配置指南技能正文。
export const OFFICIAL_ZCODE_GUIDE_REQUIRED_SEED_PATHS = [
  "skills/zcode-configuration-guide/SKILL.md",
] as const;

// design 是纯内容型插件（技能 + 设计资源 + SessionStart hook，无 MCP），技能正文按需读取 references/
// 与 scripts/；hook 只注入一句指针，正文缺失时 hook 静默退出，会话里就再也触发不到技能。
// 所以这里钉住入口、7 份规则文件、三个随包脚本和 hook，seed 缺任一项都拒绝生成残缺缓存。
export const OFFICIAL_DESIGN_REQUIRED_SEED_PATHS = [
  "skills/design/SKILL.md",
  "skills/design/references/catalog.md",
  "skills/design/references/check.md",
  "skills/design/references/create.md",
  "skills/design/references/design-system.md",
  "skills/design/references/interact.md",
  "skills/design/references/output.md",
  "skills/design/references/redesign.md",
  "skills/design/scripts/adapt-canvas.mjs",
  "skills/design/scripts/design-lint.mjs",
  "skills/design/scripts/design-tokens.mjs",
  "skills/design/scripts/import-design-system.mjs",
  "hooks/hooks.json",
  "hooks/run-hook.cmd",
  "hooks/design-rules",
] as const;

export const OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] = [
  {
    // 交互视图默认关闭，避免默认注入固定上下文；旧开关由配置迁移关闭一次。
    defaultEnabled: false,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Visualize",
      displayName_i18n: { "zh-CN": "交互视图" },
      description_i18n: { "zh-CN": "在对话中创建交互图表、解释和设计预览。" },
    },
    name: "visualize",
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    rootCandidates: [
      "packages/visualize-plugin",
      "../visualize-plugin",
      "../../visualize-plugin",
      "../../../visualize-plugin",
    ],
    version: "0.1.2",
  },
  {
    // 无 listing：宿主不进市场、不对用户露出。它必须始终可用，因为 node_repl 的注册门禁
    // 是「Browser Use 或 Computer Use 任一启用」，宿主自己不参与那个判断。
    //
    // 这里的 defaultEnabled 不违反「仅限内容型插件」那条约定（见下方 computer-use 的说明）：
    // 约定要防的是「首启即注入整套工具集并拉起 Helper」，而 seed 宿主两件都不做——工具是否
    // 进模型工具池由两个能力插件的启停决定，Helper 由 SDK 首次调用时才拉起。
    defaultEnabled: true,
    // server.js 内嵌 CUA Helper build id（每条 CI 流水线不同），由 scripts/build.mjs 同步写出。
    buildIdentityPath: NODE_REPL_HOST_BUILD_IDENTITY_PATH,
    name: OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_NODE_REPL_HOST_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/node-repl-host",
      "../node-repl-host",
      "../../node-repl-host",
      "../../../node-repl-host",
    ],
    version: "0.7.0",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "Android Emulator",
      displayName_i18n: { "zh-CN": "Android 模拟器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/android-emulator/icon.png`,
      description_i18n: {
        "zh-CN": "提供 Android 开发工作流与模拟器自动化能力。",
      },
    },
    name: "android-emulator",
    rootCandidates: [
      "packages/android-emulator-plugin",
      "../android-emulator-plugin",
      "../../android-emulator-plugin",
      "../../../android-emulator-plugin",
    ],
    version: "0.1.1",
  },
  {
    // manifest 只声明 browser-use skill；宿主 node_repl MCP 独立注入，package 另外携带其 server/client
    // runtime 资产。默认启用仅控制「何时/如何用内置浏览器」的 skill 与 browser bridge。
    defaultEnabled: true,
    hostMcpServerNames: ["node_repl"],
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Browser Use",
      displayName_i18n: { "zh-CN": "浏览器操作" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/browser-use/icon.png`,
      description_i18n: {
        "zh-CN": "操作 ZCode 内置浏览器，检查网页并验证交互。",
      },
    },
    name: OFFICIAL_BROWSER_USE_PLUGIN_NAME,
    requiredSeedPaths: OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/browser-use-plugin",
      "../browser-use-plugin",
      "../../browser-use-plugin",
      "../../../browser-use-plugin",
    ],
    // 插件 package/manifest 升版时遗漏官方 seed 版本，会继续加载旧缓存目录。
    // package、manifest、definition 三处版本应保持一致，避免发布内容和安装版本再次分叉。
    version: "0.5.1",
  },
  ...(
    [
      // 版本按插件各自升，换新缓存目录：pdf 0.2.1 起面板带中日韩字体回退；0.2.1（pdf 0.2.2）起
      // server 由工作区内各 session 共享，旧缓存的 server 不区分 session，不能沿用。
      ["documents", "docx", "Documents", "Word文档", "0.2.2"],
      ["pdf", "pdf", "PDF", "PDF", "0.2.3"],
      ["presentations", "pptx", "Presentations", "演示文档", "0.2.2"],
      ["spreadsheets", "xlsx", "Spreadsheets", "电子表格", "0.2.2"],
    ] as const
  ).map(
    ([name, skill, displayName, chineseName, version]): OfficialPluginDefinition => ({
      componentTypes: ["ui"],
      defaultEnabled: true,
      listing: {
        author: ZAI_AUTHOR,
        category: "productivity",
        displayName,
        displayName_i18n: { "zh-CN": chineseName },
        // 复用已发布的文档图标，拆分插件无需依赖新 CDN 资源。
        icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/document-skills/icon.png`,
        description_i18n: { "zh-CN": `创建、编辑与审阅${chineseName}（${skill.toUpperCase()}）。` },
      },
      name,
      // 0.2.0 起文档插件同时提供查看面板：MCP server 与面板资源由 office-runtime 构建进 dist/，
      // 缺任一项都会 seed 出能看到面板入口却无法启动的残缺插件。
      requiredSeedPaths: [
        "agents/visual-judge.md",
        `skills/${skill}/SKILL.md`,
        `skills/${skill}-viewer/SKILL.md`,
        ...OFFICIAL_OFFICE_VIEWER_RUNTIME_PATHS,
      ],
      rootCandidates: [
        `packages/${name}-plugin`,
        `../${name}-plugin`,
        `../../${name}-plugin`,
        `../../../${name}-plugin`,
      ],
      version,
    }),
  ),
  {
    // 沿用原聚合文档插件的官方搜图能力，仅拆出独立开关；认证仍由官方 MCP adapter 注入。
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Image Search",
      displayName_i18n: { "zh-CN": "搜图" },
      description_i18n: { "zh-CN": "查找插图与参考配图。" },
    },
    name: "image-search",
    requiredSeedPaths: [".mcp.json"],
    rootCandidates: [
      "packages/image-search-plugin",
      "../image-search-plugin",
      "../../image-search-plugin",
      "../../../image-search-plugin",
    ],
    version: "0.1.1",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "developer-tools",
      displayName: "iOS Simulator",
      displayName_i18n: { "zh-CN": "iOS 模拟器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/ios-simulator/icon.png`,
      description_i18n: {
        "zh-CN": "提供 iOS 开发工作流与模拟器自动化能力。",
      },
    },
    name: "ios-simulator",
    rootCandidates: [
      "packages/ios-simulator-plugin",
      "../ios-simulator-plugin",
      "../../ios-simulator-plugin",
      "../../../ios-simulator-plugin",
    ],
    version: "0.1.0",
  },
  {
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Restore Legacy Sessions",
      displayName_i18n: { "zh-CN": "恢复旧版会话" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/restore-legacy-sessions/icon.png`,
      description_i18n: {
        "zh-CN": "将旧版会话恢复为 ZCode 任务与会话记录。",
      },
    },
    name: "restore-legacy-sessions",
    rootCandidates: [
      "packages/restore-legacy-sessions-plugin",
      "../restore-legacy-sessions-plugin",
      "../../restore-legacy-sessions-plugin",
      "../../../restore-legacy-sessions-plugin",
    ],
    version: "0.1.0",
  },
  {
    defaultEnabled: true,
    name: "plugin-creator",
    version: "0.1.1",
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Plugin Creator",
      // 创建器使用客户端自带图标，不再借用 skill-creator 的远端图片。
      displayName_i18n: { "zh-CN": "插件创建器" },
      description_i18n: {
        "zh-CN": "开发、校验 ZCode 插件，完成本地 dev 市场安装、试用与更新。",
      },
    },
    rootCandidates: [
      "packages/plugin-creator-plugin",
      "../plugin-creator-plugin",
      "../../plugin-creator-plugin",
      "../../../plugin-creator-plugin",
    ],
    requiredSeedPaths: [
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ],
  },
  {
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "Skill Creator",
      displayName_i18n: { "zh-CN": "技能创建器" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/skill-creator/icon.png`,
      description_i18n: { "zh-CN": "创建、编辑和验证可复用的 ZCode 技能。" },
    },
    name: "skill-creator",
    rootCandidates: [
      "packages/skill-creator-plugin",
      "../skill-creator-plugin",
      "../../skill-creator-plugin",
      "../../../skill-creator-plugin",
    ],
    version: "0.1.0",
  },
  {
    // 纯内容型插件（只有 commands + skills，无 MCP / 无系统依赖），默认启用，
    // 让用户/agent 开箱即用地拿到 ZCode 配置指南、自诊断技能与 dynamic workflow 编写指南。
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "utilities",
      displayName: "ZCode Guide",
      displayName_i18n: { "zh-CN": "ZCode 使用指南" },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-guide/icon.png`,
      description_i18n: {
        "zh-CN": "提供 ZCode 配置指南与插件、技能、MCP、命令和钩子诊断。",
      },
      examplePrompts: [
        "How do I configure MCP servers in ZCode?",
        "Diagnose my current ZCode setup",
      ],
      examplePrompts_i18n: {
        "zh-CN": ["ZCode 里怎么配置 MCP 服务器？", "帮我诊断当前的 ZCode 配置"],
      },
    },
    name: "zcode-guide",
    requiredSeedPaths: OFFICIAL_ZCODE_GUIDE_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/zcode-guide-plugin",
      "../zcode-guide-plugin",
      "../../zcode-guide-plugin",
      "../../../zcode-guide-plugin",
    ],
    version: "0.3.0",
  },
  {
    // 设计工作流（HTML 设计稿、交互原型、HTML 演示稿）。纯内容型，默认关闭；用户可启用、可停用、不可卸载。
    // 版本与 package.json / 两份 plugin.json / sea-official-plugin-assets.mjs 同步 bump。
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Design",
      // 英文名与描述回退到 manifest（displayName / description）；这里只放 zh-CN 覆盖。
      displayName_i18n: { "zh-CN": "设计" },
      description_i18n: {
        "zh-CN": "做网页设计稿、原型和演示稿；桌面端本地工作区可在内置浏览器里点选修改。",
      },
      examplePrompts: ["Design a landing page for a budgeting app", "Build an 8-page HTML deck"],
      examplePrompts_i18n: {
        "zh-CN": ["给记账 App 设计一个落地页", "做一份 8 页的 HTML 演示稿"],
      },
    },
    name: "design",
    requiredSeedPaths: OFFICIAL_DESIGN_REQUIRED_SEED_PATHS,
    rootCandidates: [
      "packages/design-plugin",
      "../design-plugin",
      "../../design-plugin",
      "../../../design-plugin",
    ],
    version: "0.7.2",
  },
  {
    // 产品决策：电脑控制回退为默认关闭，需用户在设置页显式开启。
    // 因此这里不声明 defaultEnabled——computer-use 携带 MCP server 与系统 Helper 依赖，
    // 默认开启意味着每个新用户首启即注入整套工具集并拉起 Helper。
    // 「defaultEnabled 仅限内容型插件」的旧约定随之恢复完整。
    // 判定式是 enabledPlugins[id] ?? defaultEnabled：曾在设置页手动开过的用户已落盘
    // 显式 true，不受本次默认值变更影响。改回默认开启时，需同步
    // packages/shared/src/plugin-marketplaces.ts 的名单（bootstrap 单测机械对照两者）、
    // isZCodeCuaInternalFeatureEnabled（打包层默认 true）与输入框入口 hidden 默认值的联动语义。
    name: "computer-use",
    hostMcpServerNames: ["node_repl"],
    // 用户露出名统一为「Computer Use / 电脑控制」。包名与 producer workspace 包仍保持 zcode-cua，
    // 以兼容原生 Helper identity；EN 描述基线走 manifest
    // description，这里只放 zh-CN 覆盖；resolveLocalizedText 在 en-US 时回退到 manifest。
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "Computer Use",
      displayName_i18n: { "zh-CN": "电脑控制" },
      description_i18n: {
        "zh-CN": "自动化桌面应用：智能体驱动鼠标、键盘与界面元素，代你完成实际任务。",
      },
      // 插件更名为 computer-use 后，CDN 图标仍发布在 zcode-cua 目录；沿用资源路径避免 404。
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-cua/icon.png`,
    },
    rootCandidates: [
      "packages/zcode-cua-plugin",
      "../zcode-cua-plugin",
      "../../zcode-cua-plugin",
      "../../../zcode-cua-plugin",
    ],
    requiredSeedPaths: OFFICIAL_CUA_REQUIRED_SEED_PATHS,
    // Bug 根因：迁移 node_repl 时把旧 MCP launcher 与 SDK 仍需的 Sharp runtime 一并裁掉了。
    // Dev/desktop 会把最小 Sharp 闭包 stage 到这里；官方 cache 必须继续携带 node_modules，
    // 否则 seed 原子替换后首次截图才会报 Cannot find module 'sharp'。
    runtimeTopLevelPaths: ["node_modules"],
    // 这里的 version 追踪上游 zcode-cua runtime 版本，使插件 UI 展示、缓存路径、
    // marketplace 条目都对齐；具体版本由原子 producer bump 工作流维护。
    version: "0.6.5",
  },
  {
    // ZCode Sites（技术方案 4）：Skill 指导 Agent 把项目改造并打包成 runner 可直接运行的产物包，
    // 再用 scripts/zcode-site.mjs（CLI）上传发布；commands/ 是 /site-* 斜杠命令。
    // 0.4.0 起自带 Sites 面板（UI plugin）：MCP server 与面板页面构建进 dist/，只给面板用，模型看不到
    // （docs/site/sites-panel.md）。默认开启，用户不必先去设置里打开就能让 Agent 部署站点。
    componentTypes: ["ui"],
    name: "zcode-site",
    defaultEnabled: true,
    listing: {
      author: ZAI_AUTHOR,
      category: "productivity",
      displayName: "ZCode Sites",
      displayName_i18n: { "zh-CN": "ZCode Sites" },
      description_i18n: {
        "zh-CN": "把 Web 项目改造为可在云端 Linux 运行的部署包，一个 start.sh 即可启动。",
      },
      examplePrompts: ["Deploy this project as a website"],
      examplePrompts_i18n: { "zh-CN": ["把这个项目部署成网站"] },
      icon: `${OFFICIAL_PLUGIN_ASSETS_BASE_URL}/zcode-site/icon.png`,
    },
    rootCandidates: [
      "packages/zcode-site-plugin",
      "../zcode-site-plugin",
      "../../zcode-site-plugin",
      "../../../zcode-site-plugin",
    ],
    requiredSeedPaths: [
      "commands/site-deploy.md",
      "scripts/zcode-site.mjs",
      "scripts/stage.mjs",
      "scripts/errors.mjs",
      "skills/site-deploy/SKILL.md",
      "skills/site-deploy/templates/static.sh",
      "skills/site-deploy/templates/static-server.mjs",
      "skills/site-deploy/templates/node.sh",
      "skills/site-deploy/templates/python.sh",
      // 缺了会 seed 出能看到面板入口却启动不了 MCP server 的残缺插件。
      "dist/server.mjs",
      "dist/ui/panel.html",
    ],
    version: "0.5.0",
  },
];

// 在 official plugin 定义里标了 defaultEnabled: true 的, 拼成 `<name>@<marketplace>` 形式,
// 透传给 adapter 让它在用户没显式配置时默认开启 (内容型 plugin 才适用)。
// 注意: 任何解析 plugin 的入口 (CLI 子命令 resolveZCodePlugins、应用启动 resolveStartupPlugins)
// 都必须把这个集合传给 discoverNodePlugins, 否则 defaultEnabled 不生效。
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set(
  OFFICIAL_PLUGIN_DEFINITIONS.filter((definition) => definition.defaultEnabled).map(
    (definition) => `${definition.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
  ),
);

/**
 * 官方插件由 host CLI 注入的 MCP（如 browser-use 的 `node_repl`）server name 不带 `plugin:` 前缀，
 * 资源管理器归属插件时需要反查所属官方插件名。
 */
export function resolveOfficialPluginNameByHostMcpServerName(
  serverName: string,
): string | undefined {
  return OFFICIAL_PLUGIN_DEFINITIONS.find((definition) =>
    definition.hostMcpServerNames?.includes(serverName),
  )?.name;
}
