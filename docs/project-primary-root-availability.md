# 项目目录失效时的侧栏与会话提示

## 行为

项目已配置的主要目录被删除、移动或变为普通文件时，项目标题保留置灰提示，但仍可用鼠标、键盘和触屏展开/收起已有任务并查看历史消息；行内「新建任务」和「查看文件」按钮显示禁用态，不能创建草稿或打开文件树。仅两个按钮 hover 提示：**该项目主文件夹已被删除或移动**；项目行和标题 hover 或聚焦不显示目录失效提示。右键菜单的新建任务和所有「查看文件」条目同样禁用。单 root 直接入口、多 root 目录菜单使用相同规则；主目录失效时，附加目录仍存在也不能从项目打开文件树。

项目仍留在侧栏，未读点保留，编辑/删除/置顶入口继续可用，用户可以编辑源文件夹。缺少附加目录不禁用项目；零 root 项目仍可新建，由 Host 按既有规则分配默认目录。既有任务的 cwd、归属、正文和启动恢复策略不因本功能改变。

顶部「新建任务」与 Cmd/Ctrl+N 继续继承当前会话或草稿的项目。Host 拒绝创建时，共享新建入口直接通过现有 toast 显示本地化原因：目录缺失显示「该项目主文件夹已被删除或移动」，无法访问显示「无法访问该项目主文件夹」。保留原任务、草稿及项目归属，不重建目录，也不自动创建未归类任务。重复操作仍有反馈；目录恢复后重试沿用原创建流程。桌面和手机 shared-host 共用此规则。

错误反馈沿用新建请求的 `isCurrent()` 校验；已切换任务或被后续导航替代的请求不显示迟到错误。显式提供 `onError` 的调用方继续负责自己的错误展示，避免重复提示。根因是原失败分支只写入无人展示的 `workspaceActionError`；修复在动作失败出口反馈，不新增状态或 effect。

错误文本同时读取原生 `Error` 与手机 bridge 返回的普通对象的 `message`。原生菜单订阅跟随新建回调更新，切换语言后快捷键与按钮展示同一语言。

```text
顶部新建 / 快捷键 → 继承当前项目 → Host prepareSession
  ├─ 成功 → 原草稿导航
  └─ 失败 → 请求仍有效 → 调用方 onError / 共享 toast
                      → 保留当前页面与项目归属
```

## 只读会话的输入区提示

本地工作区目录失效后，旧会话仍按既有规则只读，不能继续输入。打开该历史会话时，在原输入框所在的底部区域持续显示现有国际化文案：

> 工作区目录不存在或无法访问，当前仅可查看历史记录。恢复该目录后重启 ZCode 即可继续使用。

提示复用会话的 bottom dock，与正文同列宽，窄屏自动换行；使用主题语义色和 `role="status"`。提示没有输入、发送、关闭、重试或重新定位按钮。正常会话、启动时的无项目草稿及没有工作区失效原因的 subagent 观察视图不显示该提示。

只读状态仍归现有 workspace tab owner，Shell 将已经本地化的 `workspaceReadOnlyReason` 传到对应工作区的 pane；跨工作区分屏不继承其他工作区的原因。组件不新增目录探测、状态副本或恢复副作用。桌面 Workbench 与手机单 pane 共用提示渲染，但本功能不新增手机或远端目录失效判定。

```text
原启动目录检查 → tab.availability → App.workspaceReadOnlyReason
  → 对应 workspace 的 SessionPane bottom dock 显示原因，composer 仍不挂载
目录恢复并完整重启 → 原启动检查确认可用 → 提示消失，composer 恢复
```

修改项目 roots 不迁移旧会话 cwd；目录恢复后只刷新侧栏也不解除已有 tab 的只读状态。以上行为与本次提示无关，继续沿用原规则。

## 状态与归属

```text
项目列表首次读取 / 项目变更 / 窗口 focus
  → 所属 Host ProjectService 读取项目快照
  → 按主目录去重，异步 stat（同一路径复用未返回的 stat；30 秒未返回按 unavailable）
  → VirtualProject.primaryRootStatus 只读投影
  → 侧栏接受最新请求的结果
      available / 无字段 → 正常入口
      missing            → 标题置灰但可展开；禁止新建/查看文件 + 删除或移动提示
      unavailable        → 标题置灰但可展开；禁止新建/查看文件 + 无法访问提示

标题展开 → 原折叠偏好 owner → 原任务行与历史消息读取（不依赖主目录存在）
新建请求 → 同一 Host prepareSession 再检查主目录 → 可用才返回 cwd
```

- `primaryRootStatus` 为可选的 `available | missing | unavailable`，由目录所属 Host 实时派生，不写 SQLite/settings/远端入口缓存，不引入 migration。旧 Server 未返回该字段时保留旧行为。
- `ENOENT`、`ENOTDIR`、路径存在但不是目录视为 missing；其他 stat 失败为 unavailable，不误报目录被删除。
- 主目录的 stat 可能永久不返回（例如 macOS 等待文件夹访问授权、网络盘无响应），且不能取消（2026-10-24，ZCT-2113660144497782784：过去 readTree/prepareSession 无限等待，侧栏一直“连接中”、新建任务一直转圈，每次刷新还再占一个 libuv 线程，4 个后 Host 所有文件操作都不再返回）。同一路径上一次 stat 未返回时复用它，不重复发起；从首次发起起 30 秒仍未返回，按 unavailable 返回，之后的读取立即得到 unavailable。该 stat 返回后删除记录，下一次读取重新检查；只复用进行中的调用，不缓存结果。
- 无主要目录的零 root 项目不标为 missing；已配置主目录失效时不能重新 mkdir 原路径、改选附加目录或回退为全局任务。
- 每次 readTree/readProjects 重新检查，不永久缓存、不轮询。目录恢复或编辑主目录后，下次刷新恢复入口。UI 在 focus 时刷新，沿用请求序号丢弃迟到响应。
- prepareSession 在返回 cwd 前复检，拒绝刷新与点击之间的失效；失败不改项目 roots 或既有任务。文件系统在最终检查后的变化仍由实际执行入口报错。
- 远端目录只由已有 remote Host attachment 检查，不在本机 stat 远端路径，不创建连接/Host/Agent。手机 shared-host 读取同一状态，桌面 continuous 和手机 replayable 的消息流边界保持原样。
- 明暗主题下标题沿用原弱化程度但不设置目录失效的 disabled/aria-disabled；按钮本身承接键盘焦点，避免重复焦点。新建和查看文件按钮保持禁用语义。远端 Host 离线仍遵守原不可展开约束。
- 主目录存在性限制新建与查看文件；折叠状态仍由原侧栏偏好 owner 持有，失效和恢复不强制收起。历史点击复用原任务选择/只读恢复链路，不修改 cwd，不为只读浏览重建目录。

## 验收

1. 单/双 root 项目的主目录移走后：标题置灰但可展开/收起并打开真实历史消息，行内/右键的新建与查看文件禁用，准确提示；附加目录仍在时也不能打开文件树或新建，编辑入口可用。
2. 目录移回后 focus 刷新恢复；仅附加目录缺失、空项目均不触发主目录禁用。
   VP-ROOT-03：目录移走后，顶部新建与快捷键均显示本地化 toast，当前历史或草稿不变、旧目录不被重建；重复操作仍有提示，目录恢复后两个入口均正常新建。桌面与手机均覆盖中英文与深浅主题；手机候选 `manual-review/pending/conversation-session-new-task-missing-root-mobile.test.ts` 通过真实 shared-host 链路验证新建失败提示、草稿保留和恢复。
3. 真实 Host 单测验证 missing/普通文件/恢复、prepareSession 复检与无副作用；远端路由不在本机探测路径。
4. pending E2E `conversation-session-project-missing-primary-root.test.ts` 覆盖真实目录移走/恢复、窗口刷新、hover、上下文菜单、明暗主题和窄布局；窄布局不等同于实际手机 shared-host 验证。
5. 主目录 stat 不返回时：真实 Host 单测验证 readTree 在截止时返回 unavailable、之后立即返回、只发起一次 stat、prepareSession 拒绝且无副作用、stat 返回后恢复；pending SSH E2E `conversation-session-remote-workspace-folder-thread-exhaustion-ssh.test.ts` 验证远端侧栏显示无法访问、新建禁用，同设备其他项目照常打开。
6. VP-ROOT-02：真实目录存在时历史与输入框正常；完整退出后移走目录，再启动并打开同一历史，底部显示上述提示且没有输入框/发送按钮，历史保留且原目录不被重建；恢复目录并重启后提示消失、输入框恢复。覆盖 Zai Light / Zai Dark、中英文、1200px / 390px 布局；390px 收起桌面侧栏后验证提示换行，不计为实际手机 shared-host 链路。候选用例：`packages/desktop/test/e2e/conversation-session/projects/manual-review/pending/conversation-session-workspace-readonly-notice.test.ts`。
