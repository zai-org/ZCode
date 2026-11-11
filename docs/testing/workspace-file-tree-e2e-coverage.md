# Workspace File Tree E2E Coverage

## Accepted Cases

| Case                                               | Spec                                                                                          | User issue covered                                                                   | Assertions                                                                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-file-tree-refresh`                      | `packages/desktop/test/e2e/workspace/files/workspace-file-tree-refresh.test.ts`                               | 1. ZCode 重命名文件后，刷新文件树仍显示旧路径；3. 点击刷新文件树按钮文件没有刷新出来 | 子目录展开加载后先折叠，真实文件系统重命名文件，再点击刷新并重新展开；文件树显示新路径、旧路径消失，并且新文件可以打开预览。                                                                                           |
| `workspace-file-tree-refresh`                      | `packages/desktop/test/e2e/workspace/files/workspace-file-tree-refresh.test.ts`                               | 2. 展开目录新增文件后文件树不实时更新，必须重启 ZCode                                | 在真实 workspace 文件系统中向当前展开目录新增文件，等待 `fs.watch` 链路触发后文件树自动出现新文件。                                                                                                                    |
| `workspace-file-tree-compact-hierarchy`            | `packages/desktop/test/e2e/workspace/files/workspace-file-tree-compact-hierarchy.test.ts` | 多层空目录压缩后，后代目录与内容不缩进，后代目录也不吸顶                             | 使用真实 workspace 文件构造两级 compact folders；展开后断言后代每层增加 `12px`、层级引导线 depth 正确，滚动后父级与后代目录都进入无额外间隙的 sticky folders。                                                         |
| `workspace-file-tree-shared-search`                | `packages/desktop/test/e2e/workspace/files/workspace-file-tree-shared-search.test.ts`     | 左侧文件树搜索深层 Java / workspace 文件时，经常搜不到 `@` 能引用的文件              | 构造未展开的深层源码文件，左侧文件树输入类名或相对路径可命中；搜索态与 `@` 使用同一 `listWorkspaceFiles` 候选和 fuzzy 排序，点击文件打开 `PreviewPane`，不会向 Composer 插入 mention；目录位于预览左侧。               |
| `workspace-file-tree-navigation-visibility-memory` | `packages/desktop/test/e2e/workspace/files/workspace-file-tree-shared-search.test.ts`     | 用户显式收起文件导航后，打开其他文件或重启 App 又自动展开                            | 在同一 workspace 打开文件 A 并收起目录，通过命令中心打开文件 B 后仍保持收起；新建空白文件标签仍展开且高亮条上下偏移和圆角均为 0，再打开文件仍收起；完整重启 Electron 并再次打开文件后继续恢复该 workspace 的收起偏好。 |

- MR !2897 / CR-01：打开、关闭并等待退场完成后，文件面板业务内容必须卸载；再次打开重新加载。减少动态效果路径立即卸载。目录 watcher 释放及未触发的 debounce 取消由数据层单测核对。

## Coverage Decisions

合并目录首次折叠回归：从未加载的 `chat` 行单击展开，等待其懒加载合并为 `chat/transport`；每轮只单击一次，断言合并行 `aria-expanded=false` 且两个子文件消失，再单击重开并检查缩进与引导线。连续执行两轮，分别覆盖仅前段路径和末段路径有展开标记的状态；保留外层重开、双主题和吸顶断言。验证状态：`covered`（macOS Electron）。旧 renderer 在 `packages/desktop/.e2e-artifacts/desktop-e2e-20261106114300018-p51607-73f7d6bd7c085075` 中单击后仍为 `expanded=true`、`visibleChildren=2`，用例失败；修复后 `packages/desktop/.e2e-artifacts/desktop-e2e-20261106114736489-p72251-bc49516ff1b6c4c9` 通过，两轮内层折叠和外层折叠均记录到 `expanded=false`、`visibleChildren=0`。

嵌套目录合并回归：在既有 `workspace-file-tree-compact-hierarchy` 用例中，构造 `api/architecture` → `chat/transport` → 两个兄弟文件。断言展示 depth 为 `1/2`、子文件比父行增加 `12px` padding、父/子引导线宽度为 `12px/24px`、引导线覆盖行高且可见；折叠并重开外层目录后重复检查，在 Zai Light / Zai Dark 下记录几何数据和截图，保留滚动吸顶断言。验证状态：`covered`（macOS Electron）。通过产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261106113041924-p96201-3eef9f5ba5331a99`；其中 `nested-hierarchy-zai-light.json` / `nested-hierarchy-zai-dark.json` 与同名 PNG 保留实际几何和截图。旧 renderer 在 `desktop-e2e-20261106112454061-p72820-af2d16da0ea1cd92` 中已因子文件缺少层级引导线失败。

| Decision                                              | Status   | Reason                                                                                                                                                               |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地 desktop + 多段 compact folders + 展开 + 向下滚动 | accepted | 同时覆盖物理 depth、展示 offset、虚拟滚动和 sticky ancestor 选择，是本次回归的最小完整链路。                                                                         |
| 普通目录（不发生 compact）                            | pruned   | 现有文件树展开路径和 helper/unit 覆盖普通 depth；不能证明本次 compact offset 回归。                                                                                  |
| Zai Light / Zai Dark 分别执行                         | accepted | 两种主题下检查缩进与引导线实际几何和可见性，保存截图以检查语义色渲染。 |
| Web / 手机 Web 重复执行                               | pruned   | `WorkspaceFileTreeRowView` 为共享渲染实现；本 case 不涉及平台服务、remote delivery 或触控专属行为。                                                                  |
| SSH / WSL / Docker workspace                          | pruned   | 本次缺陷位于 renderer 展示 depth；远端文件读取和 `workspaceIdentity` 隔离不在该 case 的行为边界内。                                                                  |
| 完整默认过滤器矩阵                                    | pruned   | `.git`、`node_modules`、`.env`、隐藏目录后代和编译产物过滤由 service 单测与文件搜索过滤 E2E 覆盖；文件树共享搜索 case 只证明它复用同一索引和排序，不复制黑名单断言。 |

## Out Of Scope

- 从未加载过的深层目录新增文件仍遵循懒加载语义，不要求自动显示。
- 已加载但已折叠目录不保持长期 watcher；这类目录依赖刷新按钮更新缓存，避免 OS watcher 数量随浏览历史无界增长。
- 远程 workspace / Web remote 的 watcher 行为不由本地桌面文件树用例证明。
- 操作系统底层 `fs.watch` 漏事件后的兜底轮询不是本轮语义。
- 大量展开目录的 watcher 上限和资源退避另行评估。
