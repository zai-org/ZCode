# 04 — 升级时保留旧版本与启动清理

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

App 升级后，只有资源变化的工具会重新下载。新版本就绪前，Agent 继续用旧版本；之后的 App 启动会删除旧版本。对话框同时显示正在使用的版本和目标版本。规则见规格的 [升级](../../preinstalled-tools/README.md#升级) 与 [启动清理](../../preinstalled-tools/README.md#启动清理)。

- **状态**：
  - 每个工具增加 `installed`。
  - `status` 规则：已安装的就是目标，或没有目标但有已安装版本，为 `ready`；目标未安装为 `not-installed`，这时可能装着旧版本。
- **升级**：
  - 安装记录与目标不同时，自动预装开启就排队准备目标，关闭就等用户点“更新”。
  - 准备期间入口仍指向旧版本。发布时先原子替换安装记录，再重写入口。
  - 新版本准备失败时，旧版本继续可用。
- **启动清理**：
  - 真正的 App 启动时，每个工具只保留安装记录指向的版本目录。其余目录先做进程占用检查再删除，有占用就保留到以后。
  - 预装进程崩溃重启后不执行这一步。
  - 当前 catalog 中没有的工具：撤销入口，再按同一规则删除它的全部目录。
- **卡片**：按规格的显示表实现：
  - “可更新”标签，以及“正在使用版本 {current}…”。
  - “更新”与“删除”按钮。
  - 没有目标但已安装的情况。
  - 准备中和准备失败时，追加正在使用的版本。

## Acceptance criteria

- [x] 测试 catalog 只改一个工具的 `resourceId` 后重启，结果符合 PT-17：
  - 只下载这个工具，其他工具没有下载。
  - 准备期间 Agent 调用仍用旧版本。
  - 发布后切换到新版本。
  - 下一次启动删除旧版本目录。
- [x] 新版本准备失败时，旧版本继续可用；卡片同时显示失败原因和正在使用的版本。
- [x] 旧版本目录被进程占用时，启动清理保留它，下一次启动再删除。
- [x] 从 catalog 移除的工具，入口被撤销，目录被删除。
- [x] 全部就绪后重启并切换工作区，没有下载（PT-02）。
- [x] 下载中退出后再启动，staging 已清空（PT-06）。
- [x] 正式版与预览版互不覆盖（PT-20）。
- [x] 清除所有数据后预装资源保留，存储页单独显示（PT-21）。
- [x] clear-data、release-isolation 两个候选按新合同改写并回放通过，仍保持待审核。

## Blocked by

- [03 — 多工具契约、串行准备与按工具删除](03-multi-tool-contract-and-queue.md)

## 验证

- 根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，以及受影响的工程测试。
- 桌面 E2E 候选在本机 macOS arm64 回放，不转正。

## Comments

- 实现 commit：`04670fc1acbba2b9e53129c0c30a8588c24f994f`（`feat(preinstalled-tools): retain installed versions`）。开工 HEAD 为 `b7df7810732`；完成前已合入集成 `b0c377605b6`，包含 06 的可选路径改写及已确认的通用诊断规格 `2443444cf09`。
- 安装记录仍是唯一事实；`installed` 由 owner 的有效记录派生。升级前/中/失败都保留旧入口，发布后切换；仅真正 App 启动检查并回收非记录版本及移出 catalog 的工具，进程占用或无法确认时保留。worker 重启只清 staging/重建入口。卡片区分已安装与目标，支持更新、失败时显示当前版本、没有目标但仍可删除已安装版本。
- 按已确认的诊断要求，运行检查失败保持 `runtime`，现有失败日志增加 `binaryArch` 和 `hostArch`，没有按工具分支，也没有新增最低系统版本字段。候选先维护落盘日志断言，再改日志实现。实际证据为小夹具 `binaryArch=x64`、本机 `hostArch=arm64`、`errorKind=runtime`；这不代表真实仿真程序运行验收。
- 必要检查通过：根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；`pnpm --filter @zcode/desktop typecheck:e2e`。根 lint 172 条存量 warnings / 0 errors，architecture 0 violations。合入 06 后重新执行全部上述检查；owner 合并保留发布/取消顺序，04 资源没有声明 rewrite，不机械重复无新行为风险的整批回放。
- 工程：`pnpm test:engineering packages/desktop/test/preinstalledToolsFaultServer.test.ts scripts/preinstalled-tools/catalog.test.ts scripts/libreoffice packages/desktop/test/tsupChunkIsolation.test.ts`，合入后 66 项通过。新增夹具的真实执行路径回归先失败（只返回版本），增加公开 `--fixture-location` 行为后通过；该 POSIX 夹具执行测试在 Windows 明确跳过。
- CLI：既有 `preinstalled-tools.test.ts` 3 项通过，验证 production/preview/development 三身份解析与独立目录、固定入口的同会话生效；`pnpm --dir apps/zcode-cli typecheck` 33 个任务通过（Turbo cache 命中），`lint` 为 0 errors / 71 存量 warnings、9 项原样上游行数接纳。没有修改 CLI 产品逻辑。
- 桌面（macOS arm64，App 3.16.3）：升级候选 run `desktop-e2e-20261029082447271-p72955-db636b4e97319490` 1/1 通过。先关闭自动预装，修改单个工具目标，再手动更新；真实 Agent 在同一会话的发布前/中/后分别执行 r1、r1、r2。另有失败保旧、旧版本原生进程占用、worker 重启不回收、App 启动回收、下载退出后 staging 清理、移出 catalog 撤入口与目录、无目标但已有安装的显示与删除断言。
- `clear-data`、`release-isolation`、`tracer` 合批 run `desktop-e2e-20261029082815313-p79868-50be83ec2f9506ad` 3/3 通过；资源清除边界、新 installed 投影、发布身份目录隔离及重启/工作区复用无重复下载均有断言。实际双 App 为 development 与真实 packaged preview；结合三身份解析测试验证隔离合同，未运行 production 包原生启动，不将本次结果写成三种 App 实例实跑。保持现有 test 构建强制 preview 的身份规则，没有为验收添加绕过。
- upgrade、clear-data、release-isolation、rewrite 的 fixture check 通过，所有候选保持 pending，不转正。已查看中英 × 深浅主题、小窗口升级截图，旧版本/目标、按钮与状态均可读；真实资源及效果由 12 验收，其他平台由 13 验收。
- 首轮升级 run `desktop-e2e-20261029081724695-p59731-0084089fb8355bb2` 失败于占用场景：E2E 重启 helper 的 HOME 扫描把提前创建的 native holder 纳入旧进程回收。独立运行时探针证明该 holder 在没有 App 祖先关系时仍被选中；改为退出屏障完成后创建占用，并断言新 App 启动后 holder 仍存活，重跑通过。没有修改产品占用规则；失败原始记录与根因证据均保留。
- 环境记录：两次 offline frozen install 遇既有 pnpm 临时 esbuild 目录 rename ENOENT，未修改依赖/锁文件，现有工具均可执行。首次根类型检查因新 worktree 缺生成的 CUA dist 失败，执行 `pnpm build:cua` 后通过。所有失败日志保留。
- 合入 06 的 5 处普通文本冲突已保存三方证据并核对：case/matrix 保留双方；CONTRACT 删除过时未实现说明；工程回归取并集；wdio 同时保留 rewrite 专属路由与 upgrade/tracer 双工具路由。自己的临时 autostash 已由主代理按精确 SHA 和稳定时间引用安全清理。
- diff、竞品词、新增文档引用及候选路径检查通过；开源提醒只包含既有 coverage matrix 的 private-signing 与根 package 的内部流程项。全部原始成功/失败工件和验证日志已保存到本次任务独立 artifacts 的 04 目录，后续清理 worktree 不影响证据。
- 未验证：production 包原生启动；原生 Windows/Linux 桌面、Windows 入口及真实仿真（13）；五工具真实资源与文档转换全链路（12）。
