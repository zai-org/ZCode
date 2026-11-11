# 本地项目使用系统多目录选择器

## 行为与归属

桌面创建本地项目、编辑本地项目的「添加文件夹」使用操作系统原生目录选择框，允许一次多选目录。沿用平台接口的 native dialog 能力，新增可选 `IPlatformService.selectDirectories(): Promise<string[]>`；Electron main 使用 `openDirectory`、`createDirectory`、`multiSelections`，返回全部路径，取消返回空数组。旧 `selectDirectory` 单选契约不变。

ProjectEditor 仍是名称、roots、primary 的唯一草稿 owner；多选结果按返回顺序追加并去重。原 roots 为空时第一个目录成为主目录，否则保留现有主目录。选择操作不创建项目、不打开 workspace 或启动 Agent，仅显式保存才调用原 `saveProject`。

```text
桌面 + 本地 Host → 平台 selectDirectories → preload IPC → main 原生多选
                                                         ↓ 全部路径 / []
                                                ProjectEditor 草稿
                                                         ↓ 显式保存
                                                   Host saveProject
远端 / Web / 手机 → 原 projectService.readDirectory(hostId) → 同一草稿
```

## 边界与失败语义

- 仅 `hostId` 未指定或为 `local`，且平台提供 `selectDirectories` 时使用系统选择器；判定不依赖当前 tab/cwd。远端项目继续浏览所属 Host，Web/手机未提供该能力，不能选择浏览器所在设备的目录作为 Host root。
- 原生选择在途期间禁用编辑、保存、删除和关闭，避免异步返回与草稿修改交错；选择完成后再合并一次。组件卸载后的结果不能触发持久化或重新打开编辑器。
- 取消不修改草稿；调用失败显示原错误区域、保留草稿并允许重试，不自动切换到另一选择方式。
- 目录选择不改变 Host 组织态、workspaceIdentity、owner/lease、桌面 continuous 或手机 replayable 语义；无数据库/CLI 协议迁移。
- 明暗主题沿用原编辑器，系统弹窗由操作系统渲染；macOS、Windows、Linux 共用 Electron 原生目录选项。

## 验收用例（accepted / pending）

| 用例  | 操作与断言                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------- |
| NDP01 | 桌面本地点击添加，一次选择两个真实目录；原生参数包含多选，不出现应用内目录浏览器；保存后重新编辑仍有两目录                  |
| NDP02 | 追加含已有目录的多选结果，只追加新目录并保留原主目录；取消选择不变更目录；取消编辑不保存                                    |
| NDP03 | 原生选择在途时禁止保存/关闭，失败后草稿保留且可重试；远端 Host 即使具备原生能力也使用 Host 浏览；Web/手机无原生能力仍可浏览 |
| NDP04 | 原有单选仍返回一个路径或 null；多选取消返回 []；明暗编辑器可用                                                              |

Electron 交互用例：`packages/desktop/test/e2e/workspace/projects/project-native-directory-picker.test.ts`。mock 仅替代系统弹窗的用户返回值，真实执行 UI → preload → main、保存与重新编辑；不声称覆盖操作系统原生窗口内的鼠标多选。单测覆盖 Host/平台边界及失败/在途状态。既有本地目录浏览 E2E 同步改用原生弹窗 mock。真实手机连接与 Windows/Linux GUI 需另行验证。

## 验证记录（2026-09-15）

- 相关单测 5 文件 / 21 项通过；`pnpm typecheck`、desktop `typecheck:e2e` 通过；`pnpm lint` 0 errors / 47 既有 warnings。
- Electron：`desktop-e2e-20260915125744659-p84856-08e67d2dd0407c35`，2/2 通过，包含 NDP01/NDP02、既有 WCP01 删除后重启回归及明暗截图。
- `architecture:check --changed --base HEAD` 为 0 violations；默认 staging 基线检查仍有开工前已存在的 `packages/ui/src/root/resolveConversationWorkspaceTarget.ts` unmanaged-new-file，未新增违规。
- 未运行真实手机配对、SSH/WSL Host、Windows/Linux GUI 或原生弹窗内手动多选；这些边界不以桌面弹窗 mock 代替实测。
