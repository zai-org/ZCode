# 项目目录插件的手动信任

> 状态：已实施
> 日期：2026-11-17
> 关联：[Workspace-level Plugin Architecture](./workspace-level-plugin-architecture.md)、
> [Deep link 与项目信任边界](../security/deep-link-project-trust-boundary.md)、
> [Workspace Hook Trust](../specs/workspace-hook-trust.md)

## 1. 背景

项目配置 `<workspace>/.zcode/config.json`（以及 `zcode.json`、显式 `projectConfigPath`）可以用
`plugins.dirs` 声明随仓库分发的目录插件。2026-10 的安全修复（`fix(plugins): block workspace plugin
directories`）为了堵住「打开仓库即执行插件 Hook、启动插件 MCP」的攻击链，直接在读取时丢弃了项目
`plugins.dirs`。结果是团队无法再靠仓库分发插件，设置页「项目」视图也看不到这些插件。

本规格恢复项目目录插件，但默认不加载：用户在设置页逐个点「信任」后，插件才在之后新建的会话里生效。

## 2. 用户可见行为

- 设置 → 插件 →「项目」视图列出项目 `plugins.dirs` 声明的插件。未信任的插件显示「待信任」标识，
  开关锁定为关，菜单里没有「启用」，也没有「打开」UI 入口；行内和详情页提供「信任」按钮。
- 未信任时，插件的 Hook 不执行，MCP 不启动，技能、命令、Agent 不出现，模型请求里没有它的工具。
- 点「信任」后，记录写入本机用户域存储，提示「新会话生效」。之后新建的会话按项目/用户配置的启停
  状态加载插件；开关恢复为配置里的启用状态。已经运行中的会话不热加载新信任的插件。
- 插件的清单（manifest）或 Hook/MCP 声明文件变了（例如 `git pull` 拉到新版本），插件回到「待信任」；
  只改脚本、技能正文等其它文件，信任保持。
- 不在打开项目或新建会话时弹窗询问；会话里也不提示「有 N 个项目插件待信任」。
- 「用户」视图不读取项目配置，所以不出现项目目录插件；用户自己在 User 配置 `plugins.dirs` 登记的
  同一目录按用户来源加载，不需要项目信任。

## 3. 信任模型

```text
项目配置 plugins.dirs ──► 候选目录（只进 ConfigResult.sources.plugins.dirs.workspace，
                          不进可执行的 config.plugins.dirs）
                              │
插件发现（启动 / plugins/list）── 每个候选：读 manifest + 声明文件 → 声明摘要
                              │
用户域记录 workspace-plugin-trust-v1.json ── Trust identity + 插件根相对路径 + 摘要 精确命中？
                              │
                 ┌────────────┴────────────┐
               命中                       未命中
   enabled 按配置，解析 Hook/MCP/       enabled=false，不解析任何组件，
   技能/命令/Agent，workspaceTrust=     workspaceTrust=pending，只给设置页展示
   trusted
```

- **记录位置**：与 Hook 信任存储同目录（`<用户存储根>/security/workspace-plugin-trust-v1.json`，
  路径由 `resolveWorkspaceHookTrustStorePath` 推出）。项目文件不能改写用户存储根，仓库里同名文件
  不会被读取。写入用文件锁加原子写。存储读不出或损坏时按「没有信任」处理，候选仍显示为待信任。
- **Trust identity**：复用 Hook 信任的 `resolveWorkspaceHookTrustIdentityForWorkspace`。远程工作区
  用 `workspaceIdentity`；ZCode 受管 worktree 归一到源仓库路径，所以沿用源仓库的信任
  （规则见 Workspace Hook Trust D23）。换工作区、换远程主机、换电脑都要重新信任。
- **插件根键**：插件根相对工作区目录的路径，统一用 `/`。受管 worktree 与源仓库得到同一个键。
- **声明摘要（v1）**：sha256，输入为插件根键，以及下列文件的原文（换行统一为 `\n`，缺失记为 null）：
  manifest、`hooks/hooks.json`、`.mcp.json`、manifest `hooks` / `mcpServers` 里以路径引用的文件。
  内联在 manifest 里的 Hook/MCP 声明随 manifest 原文覆盖；以嵌套数组引用的文件与 MCP 加载一样递归展开。文件按路径的码点顺序排列，不受系统语言设置影响。实现集中在
  `apps/zcode-cli/packages/adapters/src/plugins/workspace-plugin-declaration/`，启动发现、打开会话的实时
  目录和信任写入共用。
- **一次信任放行全部组件**：插件自带的 Hook 不再按项目 Hook 规则逐条信任。

## 4. 准入位置

- 启动发现与 `plugins/list` 共用 `NodePluginAdapter.discoverPlugins`。bootstrap 在构造请求时调用
  `resolveWorkspacePluginDiscovery`（`apps/zcode-cli/packages/bootstrap/src/workspace-plugin-trust/`）读入候选与本工作区的信任记录；发现时摘要与 manifest 读自同一批
  发现材料，材料在本次发现中途变化时整体重建，准入判定的声明就是随后被解析执行的声明。
- 打开会话里的 MCP 配置与技能实时目录只沿用会话启动时已准入的项目插件（来自启动发现结果的
  `workspaceTrust.state === "trusted"`），每次重读都重算摘要；会话中途声明变了就撤下该插件的 MCP
  与技能。新的信任不进入已打开的会话。
- 插件扩展进程只读取 User 配置视图（`configScope: "user"`），项目目录插件不会进入扩展进程。

## 5. 协议与多端

- `ZCodePluginInfo.workspaceTrust`：`{ state: "pending" | "trusted", pluginRoot, declarationDigest }`，
  只有项目目录插件才有。
- `plugins/workspaceTrust`：参数 `{ workspace, pluginRoot, declarationDigest, trusted }`，结果
  `{ accepted, reasonCode? }`。信任时在文件锁内重读项目配置与插件声明，摘要必须与设置页看到的一致，
  否则返回 `workspace_plugin_declaration_changed`，避免「批准 A、执行 B」。`trusted: false` 撤销该插件根
  的记录。存储不可用时返回 `workspace_plugin_trust_unavailable`。
- App 侧经 `IPluginManagementService.setWorkspacePluginTrust` 路由到目标 Host（本机、SSH/WSL/Docker
  远程）。手机远控复用同一 Host 与 PluginManagement 频道，可以点「信任」。

## 6. 验证

- CLI：`adapters/tests/config.test.ts`（候选只进 sources，非法值不拖垮其它声明）、
  `adapters/tests/mcp-config-loader-rules.test.ts`（打开会话只沿用已准入且摘要未变的插件）、
  `bootstrap/tests/plugins-protocol.test.ts`（待信任 → 信任 → 已信任；技能正文变化保持信任；
  Hook 声明变化回到待信任且旧摘要被拒；另一个工作区仍待信任；撤销；仓库伪造记录无效）。
- E2E：`WPL-014`（`conversation-session-plugin-mcp-skill-workspace-root`）。
