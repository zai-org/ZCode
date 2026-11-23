# iOS 项目静态发现

## 问题与边界

`ios_discover_project` 用于了解项目，不得执行项目代码。原实现为列举 scheme 调用
`xcodebuild -list -json`；Xcode 可在此期间求值本地 Swift 包的 `Package.swift`。
因此即使只是概括项目，项目控制的清单也能在插件进程权限下执行命令。
MCP 工具授权不等于对插件内部每个子进程的独立审批。

## 行为契约

- 输入仍为 `{}`，输出仍为 `{ projects, workspaces, schemes, bundleIds }`。
- 沿用现有目录扫描范围，发现 `.xcodeproj` 与 `.xcworkspace`。
- `schemes` 只包含这些容器内 `xcshareddata/xcschemes` 和
  `xcuserdata/*.xcuserdatad/xcschemes` 中已有普通 `.xcscheme` 文件的名称，去扩展名、去重并排序。
  不推测自动生成的 scheme，不求值 `Package.swift`，不解析依赖。
- `bundleIds` 沿用 `project.pbxproj` 的静态文本提取，不展开构建变量。
- 没有静态 scheme 时返回空数组；不能通过执行 Xcode 或其他命令补齐结果。
- 发现过程不启动任何子进程，不要求安装 Xcode，不写入项目或构建缓存。
- 工具描述明确静态范围及结果可能不完整。MCP 工具名、schema、现有权限策略、
  Hook、结果包装、会话事件与桌面/手机投影不变；历史结果不改写。

```text
概括 / 发现项目 → ios_discover_project → 静态文件读取 → 已有元数据
构建 / 运行请求 → ios_build_app / ios_build_and_run → Xcode 求值与构建
```

## 构建兼容

动态 scheme 列举归 `providers/build.ts` 所有，仅由已有构建工具调用。
构建入口先按显式 workspace、显式 project、自动 workspace、自动 project 的顺序选源。
未传 `scheme` 时，对选中的源执行 `xcodebuild -list -json`，采用其首个 scheme；
列举失败或没有结果时沿用已有容器名回退，不采用其他项目的静态 scheme。显式 `scheme` 不再触发额外列举。
构建工具描述说明会执行项目代码；仅概括项目不应调用构建工具补齐发现结果。
本次不新增动态发现 MCP 工具，不修改自主模式或增加新的审批通道。

## 回归验收

1. 含本地 Swift 包的项目与 workspace 调用发现时，子进程执行入口调用次数为零；
   不返回只可通过求值生成的产品 scheme。
2. shared/user scheme、重复名、空目录及非 scheme 文件的静态发现符合契约；
   显式扫描目录与进程 cwd 不同时仍从指定目录读取。
3. 构建时动态列举仍能选中自动生成的 scheme；显式 project 不被自动 workspace 覆盖；
   显式 scheme 不触发列举。
4. macOS 真实运行：本地清单只运行 `/usr/bin/id -u`，将 UID 写入产品名。
   直接 Xcode 列举可产生 `ZCODE_ID_UID_<uid>`；打包后的 MCP 发现调用不求值清单，
   返回静态结果，进程探针记录的 `xcodebuild` 启动次数为零。用独立临时目录避免清单缓存影响判断。
5. 静态发现测试不依赖 macOS、Xcode 或模拟器；实际 Xcode 行为只在 macOS 验证。
