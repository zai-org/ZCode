# 10 — 其他平台资源包产出（结构检查）

Status: in-progress

## Parent

[01 — 桌面文档工具预装：LibreOffice](01-libreoffice-preinstall.md)

## What to build

扩展 09 的转换工具，产出其余五个目标的资源包和清单条目，供之后的人工或独立任务做实际运行验证。
本票只做结构检查，不在目标平台上运行（spec 决策 15）。

- macOS x64：与 arm64 相同，从 dmg 中取出 `.app`。
- Windows x64、arm64：从官方 MSI 中解出程序目录，随包提供 VC++ 运行库，并在资源包里记录运行库的来源和许可。
- Linux x64、arm64：从官方 deb 包中解出程序目录。
- 所有包都加入随包中文字体、许可说明和官方源码获取方式，并输出清单条目。

## Acceptance criteria

- [ ] 五个资源包都能由工具重复产出，并通过 02 契约的运行时校验。
- [ ] 结构检查通过：必需文件齐全；Windows 包包含 VC++ 运行库；归档格式、大小和 SHA-256 都已记录。
- [ ] 每个包的“未在目标平台运行验证”状态写在清单说明和 12 的检查表中，不写成已验证。

## Blocked by

- [09 — 官方包转换工具与 macOS arm64 资源包](09-converter-tool-and-macos-arm64-package.md)

## 验证

在本机 macOS arm64 上完成，不在目标平台上运行。

- 先补工程回归测试，再改实现：覆盖 MSI 解包、deb 解包、运行库是否齐全、必需文件和清单字段。运行方式为 `pnpm test:engineering <文件>`。
- 在本机对五个产物逐个跑契约校验和结构检查，并记录结果。
- 本票不阻塞 11。实际运行验证见 12。

## Comments

### 2026-10-28 — 本地工具完成，真实资源包验收阻塞

- 本票保持 `in-progress`，没有新增 commit。以已合入的 `23cd234c639` 为最终基线承接 09 的待提交工具基础；09 已独立提交的共享前置为 `f7dbeb5c2de`、`037bf23dc61`。
- 已完成本地转换路径：macOS x64 复用签名完整的应用与私有字体视图；Windows 按 PE 架构从 MSI 合并模块选择原始 VC++ DLL，形成 app-local 运行库并保留来源、实际摘要与许可；Linux 由 libarchive 只提取 deb 数据，不运行安装脚本，并检查 ELF64 与 GNU version-needs 的 glibc 2.28 上限。其他平台的程序均未执行。
- 先更新 spec 01 再实现：明确补充运行库的有限输入、结构检查与运行验收的边界；所有生成描述保持 `runtime: not-run`。12 只增加输入库存与未运行状态，仍为 `ready-for-human`，未执行其验证任务。
- 同时修复 09 源下载的两个可重复缺陷：超出配方字节数的响应在写盘前中止，避免无限响应占满磁盘；同名并发下载改为不覆盖的原子源缓存发布，已有内容必须与本次配方一致。工程回归均先观察失败，再验证修复；不增加通用下载队列。
- 最终检查通过：根 `pnpm typecheck`、`pnpm lint`（172 项既有 warning，0 error）、`pnpm architecture:check --changed`（0 violation）；制作工具独立 lint 0 warning、0 error；改动格式、diff 和竞品词检查通过。未修改 CLI 源码，不重复运行 CLI 全量检查。开源提醒只命中已有 coverage 文档和 package 脚本，内部制作目录已整体排除。
- 工程夹具验证：24 项通过。覆盖五个目标的转换分支、GNU ar/deb 数据提取、原生和错误 PE/ELF 架构、普通／延迟 VC++ 导入、运行库缺失／许可缺失、补充资源不可覆盖原文件、相对链接、glibc 上限、重复归档相同、下载超限与并发输入保护。GPG、MSI、DMG 外部命令使用受控边界；不能据此声明真实签名或实际平台运行成功。
- 官方输入：其余五个 26.8.1 安装包和签名文件均已下载；安装包实际大小和 SHA-256 与官方元数据一致，固定配方保留这些值。五次真实转换均在 `spawn gpg ENOENT` 停止，未挂载或提取官方安装包；尚无转换后归档大小和摘要可交付。
- 阻塞：GnuPG 安装许可尚待确认；Windows 的 `msiextract` 也未安装且未获安装授权。未执行真实 GPG 校验、五个官方资源包产出／重复比较、真实 PE/ELF/运行库/glibc 结构检查及任一目标平台运行。未推送或创建 MR，也未运行桌面 E2E。
- 证据保存在本地协调目录：`10-downloaded-inputs.json`、`10-real-attempts.json`、`10-local-tests-final.log` 与各项红／绿回归日志。完整 09+10 待提交补丁另存，保留工作区等待必要验证；不把未完成项写为通过。

### 2026-10-28 — 真实转换与固定选包

- 六个 26.8.1 官方输入已实际 GPG 验签。macOS x64 已真实产出并检查签名与链接，未运行目标程序。Windows 真实 msiextract 用时约 141 秒，超过原通用两分钟上限；现采用有红绿回归的独立十分钟执行上限，超时仍是失败。
- MSI 的不同架构 CRT 会覆盖同一目标文件名。现按 File／Media 的唯一 ID 读取同一已验签 CAB，遵守 Component 中明确的 ARM64 条件，再检查实际 PE；不按目录名猜架构。macOS libarchive 选择解包曾产生错误字节，经 gcab 独立对照确认后改用 gcab，保持普通／延迟导入、架构、许可和完整性门禁。
- 26.8.1 两个 Linux 包均要求 GLIBC 2.34，独立 GNU version-needs、具体 ELF、偏移和原始字节确认了生产解析结果。有界探针只检查官方 25.8.7：x64 全量 263 个 ELF 最高为 2.28，因此固定 x64 配方改为 25.8.7；arm64 入口与 Python 仍需 2.34，停止历史搜索并保留阻塞。
- 本票保持 in-progress：Linux arm64 没有合规产物，不能以其它目标产出关闭整票。最终产物及重复性库存另附本轮证据；所有非本机目标实际运行均为 not-run，12 保持 ready-for-human。

本轮已产出的非本机归档如下，均未发布、未运行目标程序。真实服务解包、必需文件与身份核验通过；Windows 同时通过入口／CRT 架构、导入依赖、来源与许可检查，Linux x64 最高 GLIBC 为 2.28。

| 目标          | 版本   | 归档字节数 | SHA-256                                                            |
| ------------- | ------ | ---------: | ------------------------------------------------------------------ |
| macOS x64     | 26.8.1 |  340090151 | `bf7c54ed22e7d76d4c32c039f0b4e96878c7f87ae6e3bb91058aa545738cc44a` |
| Windows x64   | 26.8.1 |  553961488 | `82b7bf46f7f4e6398848ee515d1fcb5d86036a8d442acda6357bb5141883f373` |
| Windows arm64 | 26.8.1 |  542125206 | `8b8217936bf9435ed5f82dbb13f678b0ec72f7381ea8491ef5244fe40e792036` |
| Linux x64     | 25.8.7 |  362040180 | `66a55af5fc0e1ccb4515e75c69cbfee1fa005791ffdf3ae9214dedf0fbf06e74` |

- 上述四包及 09 的 macOS arm64 包均完成两次完整生产转换；归档 SHA-256 与 artifact 描述逐字节相同。所有包通过真实服务解包、必需文件和身份核验；未执行非本机目标程序。
- 最终制作工程 31/31、根 typecheck、lint（172 项既有 warning、0 error）、architecture（0 violation）、格式与 diff 检查通过。开源词检查无发现，导出提醒只有既有两项。未新增 child commit，增量交主集成统一提交；未推送或发布。

### 2026-10-28 — 最终提交记录

- 已验证工具及四个其他目标的实现已提交：`8d5b8529d7d9b42db91fedb561f6a330ca54810d`；不是整票完成。macOS x64、Windows x64/arm64、Linux x64 共四包两次完整转换一致，结构及服务解包／身份检查通过；Linux arm64 仍受 GLIBC 2.28 门槛阻塞。所有非本机平台运行仍未执行，Status 保持 in-progress。

### 2026-10-28 — 26.2.x Linux 候选核对

- 官方 26.2.6 的 Linux x64 与 arm64 安装包均完成固定指纹 GPG 验证，实际交给现有转换工具读取 ELF；两者均要求 GLIBC 2.34，超过 2.28，下游制作按契约拒绝。
- 26.2.x 没有解除 Linux 兼容门槛。保留 x64 的既有 25.8.7 配方；arm64 仍无合规产物。本轮没有运行 Linux LibreOffice，也没有降低门槛。

### 2026-10-29 — 由新票接手

- 剩余工作由预装工具通用化的新票接手：按新打包规则重新产出由 [07](../preinstalled-tools/07-packaging-common-and-libreoffice.md) 负责；Linux arm64 及其他平台的产出与验证由 [13](../preinstalled-tools/13-other-platform-verification.md) 负责。本票状态不变。
