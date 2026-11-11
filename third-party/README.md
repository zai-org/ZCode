# 第三方材料维护

发行物使用根目录的 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)。它保留 npm 包内的 LICENSE、COPYING、NOTICE、README 许可段，以及复制源码和原生组件的许可文本；不从 npm author 字段生成版权行。

用户取得声明的入口：

- Desktop：安装目录的 `resources/THIRD-PARTY-NOTICES.md`；macOS 为 `ZCode.app/Contents/Resources/THIRD-PARTY-NOTICES.md`。`Resources/licenses/electron/` 另外保存目标平台 Electron 原文、Chromium 汇总及校验清单。
- Web：部署根目录的 `THIRD-PARTY-NOTICES.md`；构建后的 HTML 带 `rel="license"` 链接。
- 发行 CLI：`dist/THIRD-PARTY-NOTICES.md` 作为伴随文件随构建产出，`pnpm build:zcode` 的统一分发包复制到 `agent/THIRD-PARTY-NOTICES.md`。`zcode --licenses` 入口与 SEA 内嵌 Node 精确版本许可尚未接入：SEA 基底取构建机 Node 版本，而 `runtime/sources.json` 只登记 22.16.0 与 24.14.0，CI 浮动 Node 24 时会因缺少对应原文而无法构建。开发态 `tsx src/main.ts` 不经过发行入口。
- 搜索工具：准备后的每个工具目录包含 `THIRD-PARTY-NOTICES.txt` 和 `SOURCES.json`（内网镜像下载与仓库归档两条准备路径都写入，缓存命中也刷新）。SEA 同时嵌入这些材料。producer 打出的 tar/zip 仍只含二进制，保持与已固定 SHA-256 的归档逐字节一致。
- 远端 Node 和独立 Server 的 node-runtime 组件：`LICENSE.node.txt` 与 `NODE-SOURCES.json`。缓存命中也刷新材料。Server、Agent、插件与搜索工具的独立组件分别附带适用声明，在计算组件哈希前完成复制。

## 当前依赖树的生成状态

`THIRD-PARTY-NOTICES.md` 与 `inventory.json` 已在冻结安装后按当前锁文件重新生成，基础许可分类、声明输入哈希和新鲜度校验通过。OFL-1.1 作为标准开放字体许可参与分类，完整原文仍必须随对应字体包进入声明；开源导出流程会再按开源树的实际依赖重新生成，两棵树不共用生成结果。

基础检查通过不代表材料缺口已关闭：`inventory.json` 的 `reviewRequired` 仍保留待补齐的原文和来源证据。当前覆盖的精确包版本、复制组件与待核验数量以生成清单为准，避免文档中的历史数量被误当作当前状态。

## 更新依赖后

```sh
pnpm install --frozen-lockfile
node scripts/licenses.mjs notices
node scripts/licenses.mjs check
# 发布前的材料完整性检查：存在已登记缺口时失败，不能靠更新哈希放行。
node scripts/licenses.mjs check --strict
```

严格检查目前只作为显式命令运行，尚未接入 SEA 的 CI 发布和手动 SMB 上传入口：当前清单仍有已登记缺口，接入后这两条发布路径会立即失败。本地构建仍可用于核验修复，基础检查会明确提示未解决数量。

生成器以根 lockfile 的生产依赖图为覆盖集合，并先把两侧换行统一为 LF 再严格比对 `pnpm-lock.yaml` 与 pnpm 的 `node_modules/.pnpm/lock.yaml` 安装快照（Windows autocrlf 工作区的 CRLF 不算依赖图漂移）；旧安装图必须先 frozen install，不能直接重生成。Windows 上递归 `pnpm list` 会超过文件句柄上限，因此生成器固定根 lockfile，按唯一 workspace 名称逐项读取 lockfile-only 图，避免跨 workspace dedupe 漏掉传递依赖。标识门禁和声明生成共用该锁图，再按真实目录递归扫描实装包并防环。相同原文按 SHA-256 去重；同名不同版本分别记录。支持的平台可选包必须已安装。三个未安装 Canvas 目标（Android、Linux armv7、Linux riscv64）不属于当前桌面发行目标。

审核并提交通知和 `inventory.json`。清单同时记录锁文件、manifest、补丁、复制文件和补充材料的哈希；版本变化或声明被截断会使显式检查失败；构建只读取已有声明，不因此中断。该检查确认材料新鲜度与许可标识，不自动证明所有发行义务已经履行。

工作区输入的新鲜度哈希将 CRLF 统一为 LF，兼容 Windows checkout；上游原文快照、归档和最终发行声明仍按原始字节校验。

`npm-overrides.json` 保存发布包缺少材料时采用的固定上游来源与原文 SHA-256。升级这些包时需要重新核对对应版本；不得把旧版本材料直接套用，也不得编造版权人。`upstream/` 和 `native-search/licenses/` 为原文快照，不要运行格式化工具改写。

## 原生搜索

`native-search/sources.json` 对应当前 18 个归档：桌面/SEA 的 bfs 4.1.1、ugrep 7.8.4、ripgrep 14.1.1，以及远端 macOS 的 ripgrep 13.0.0。链接依赖包括 Oniguruma、PCRE2、压缩库、Rust crate 和运行库材料。Cargo.lock 的收集范围保守包含可选、构建和测试依赖，不代表所有库都链接进每个平台。

ugrep 的 BSD-3-Clause 版权、条件和免责声明完整保留。ripgrep 保留 MIT/Unlicense 两份文本，zstd 采用 BSD 选项；GCC 运行库保留 GPL 文本和 Runtime Library Exception 3.1，不把这一例外误写成要求应用整体采用 GPL。Sharp/libvips 由真实 Computer Use 包引入，声明保留 LGPL-3.0-or-later 材料，其内置库原文缺口继续登记在待核验清单中。

升级原生工具时，先核对构建配置和源码包，更新组件版本、上游 URL、源码校验值和实际许可文件；再更新 `sources.json` 的配置哈希。生产者打包会核对组件版本，打出的归档同时附许可材料。归档的最终 SHA-256 在包外维护，不能把含有自身哈希的文件放回同一归档。更新仓库归档和配置 pin 后，再更新材料中的二进制输入归档记录、重新生成根通知，并核对各平台准备产物。

仓库已有的 18 个输入归档保持原始校验值，其许可材料随源码仓库保存在这里；不要脱离声明单独转发旧输入归档。准备和重新打包后的目录/归档会自带通知，`SOURCES.json` 额外记录实际二进制哈希。

## 已明确的资料边界

- ARMS 按当前生产依赖图进入声明，部分原始材料仍待补齐；不沿用其他分支已移除它的结论。`@dukelib/sheets-wasm@0.1.21` 已取得 `wasm-v0.1.21` 对应 commit 的原始 LICENSE。
- 当前有 21 个包未取得对应版本的完整 LICENSE 文件，保留发布方许可标识、可取得的 README 许可段及标准条款，逐项记录在 `npm-overrides.json` 的 `evidenceKind` 字段。`reviewEvidence` 保存本次 npm 归档哈希及可取得的固定上游树证据。标准条款不能冒称上游原始版权声明；它们继续出现在清单的 `reviewRequired`，严格检查失败。其中 6 个是 sharp 预编译的 `@img/sharp-libvips-*`（只由真实 Computer Use 包引入）：发布方只声明 LGPL-3.0-or-later，并在 README 许可段列出 aom、cairo、glib 等约 28 个内置库，各内置库对应版本的原文尚未收集；标准条款取自 SPDX license-list-data v3.27.0（其 LGPL-3.0 文本已内含 GPL-3.0 全文）。
- `embedded-components.json` 记录 Canvas 0.1.100 的 Skia 子模块和 quickjs-wasi 2.2.0 的 QuickJS-NG 子模块固定 revision 及完整原文。现已补充固定 Skia DEPS 中的字体、图片、压缩库材料，以及 QuickJS 的 WASI libc、LLVM runtime、Mbed TLS、Project Everest 和 Ada URL parser 材料；`buildEvidence` 保存构建脚本和 SDK submodule 来源，按原文字节校验。Mbed TLS 采用 Apache-2.0 选项，FreeType 采用 FTL 选项。各平台最终二进制、Rust/C++ 运行库及全部嵌套依赖的对应关系仍未完成核验，两项 reviewRequired 保留。
- 原生来源清单中的 Rust 标准库 revision `6a6eaca656978778f7c1c750ee0c3db87f8bffb2` 尚无原文快照。本次从两个 Windows ripgrep 输入归档的 PE 文件重新提取出相同 revision，但公开 rust-lang/rust 无对应 commit；没有用其他 Rust 版本的材料替代。连同上述 npm 包、复制源码、内嵌组件与链接来源问题，`inventory.json` 的 `reviewRequired` 当前共 25 项。
- shadcn、AI Elements、Fig 注册表和 Material Icon Theme 的当前文件及核验许可证均已记录。当前 checkout 没有最初复制 revision，因此 `importRevision` 为 null；固定的许可参考 commit 不冒充最初复制版本。
- 预编译原生工具的编译器/PCRE2 字符串与构建输入已记录。musl 的精确补丁版本未能从现有二进制恢复，保留上游 COPYRIGHT 参考并明确标记。源码配置和材料清单不等于每个平台最终安装包的完整链接审计。

最终安装包仍应通过发行流程实际生成并核对；本目录不把类型检查通过、动态加载或“未修改”当成 LGPL/MPL 等许可义务的通用豁免。

`runtime/sources.json` 保存 Node 22.16.0（远端）和 24.14.0（当前 SEA）的固定版本原文来源与 SHA-256。升级 Node 时必须先更新对应材料。Electron 原文来自构建中实际下载并解包的目标平台归档，不用宿主 `node_modules/electron/dist` 替代。桌面配置的 `afterExtract` 在 macOS 清理前复制材料；`afterPack` 不执行许可校验。验证时应覆盖该配置 hook。

## 复制源码、技能与文档的补充归属

`copied-components.json` 是复制内容的登记入口，`inventory.json` 保存对应文件、固定上游参考和 SHA-256，根 `THIRD-PARTY-NOTICES.md` 由生成器输出原始版权及许可文本。最初引入的 commit 未记录时保留 `importRevision: null`，不把本次核验的版本当成最初版本。

Knip 文档镜像现已登记：原始导入的 169 个文件与上游 Knip 6.0.6 的固定参考提交逐一匹配，补齐 ISC 原文；随镜像复制的 Source Sans Pro 与 Hack 字体按字体内版本单独登记原始许可。来源、版本与本地改动说明见 [镜像 README](../docs/knip/docs/README.md)。

Apache-2.0 复制内容中的 147 个已确认改编文件包含文件内来源和 `Modified by ZCode:` 声明，并登记到 `modifiedFiles`；生成时校验该声明仍存在。Markdown frontmatter、脚本 shebang 和 JavaScript directive 保持有效。未确认源自上游的自有文件不追加上游归属。

| 内容                        | 本地范围                                                                                           | 上游许可与修改说明                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| shadcn/ui                   | `packages/ui/src/components/ui/`、`packages/ui/src/styles.css` 的上游衍生部分                      | MIT；本地修改包含样式、国际化和组件组合，自有组件不归属于上游。                                                                                      |
| AI Elements                 | `packages/ui/src/components/ai-elements/`、`.agents/skills/ai-elements/`（含 references、scripts） | Apache-2.0，Copyright 2023 Vercel, Inc.；本地修改包含样式、导入路径、组件扩展及技能使用说明，参考 commit 中包含技能正文。                            |
| agent-browser、dogfood 技能 | `.agents/skills/` 下对应两个目录                                                                   | Apache-2.0，Copyright 2025 Vercel Inc.；固定 v0.20.0 的实际 commit 核对原技能和 LICENSE，本地说明和使用约定有修改。                                  |
| VS Code IPC 与基础工具      | `packages/rpc/src/`、`packages/rpc/examples/` 中的衍生部分，及 `wire-codec.ts` 对该传输格式的适配  | MIT，保留 Microsoft 原始版权行；本地进行了模块拆分、传输扩展、注释和封装修改，不将所有本地实现归属于上游。                                           |
| Superpowers 技能描述        | `packages/ui/src/lib/builtinSkillI18n.ts` 中的 Superpowers 描述及翻译                              | MIT，Copyright (c) 2025 Jesse Vincent；对应上游 v5.1.0。原插件目录当前仅余 LICENSE，不声明仍分发已删除的整包实现。该文件其他技能描述不在此授权范围。 |

已核对 `@pierre/diffs@1.1.22` 的实际安装包：生产依赖声明已经包含其 Apache-2.0 标识及原始 LICENSE，不另造一份重复声明。

### 尚不能仅靠补声明关闭的条目

- React Best Practices：上游 `vercel-labs/agent-skills` 的固定参考 `063bee94c3f4df8453406c830b0a7df0f2860278` 中，根 README 与技能 frontmatter 声明 MIT，但树中无完整 LICENSE 文件。保留本地 Shu Ding / Vercel 署名；未编造上游版权年份或许可证原文。现已登记到 `copied-components.json`，参与输入哈希和严格门禁。来源：[README](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/README.md)、[技能声明](https://github.com/vercel-labs/agent-skills/blob/063bee94c3f4df8453406c830b0a7df0f2860278/skills/react-best-practices/SKILL.md)。
- `webfetch-processing.ts` 的清单判词称其提示词来自 Gemini CLI，但本次取得的上游 `cfbcaa8df13ea4610bb379b377b56d62980c0032` 的 `web-fetch.ts` 未找到被指认的句子；无法据此添加 Google 归属并宣称问题解决。
- Windows 浏览器导入中的解密实现、混合来源技能描述、商标资产和兼容层的授权/来源问题，需要各自的证据，不能通过追加通用 NOTICE 关闭。
- 原清单提及 `apps/zcode-cli/.agents/skills/` 下的技能，但该目录在当前 checkout 中不存在；锁文件中残留来源信息不代表还分发那些文件。

待核验条目以当前 `inventory.json` 的 `reviewRequired` 为准。其余来源疑点尚未证明属于第三方复制，不凭相似性推定权利人；需要另行核对。基础声明新鲜度检查通过不代表这些边界问题已经解决。具体规则与验收见 [SPEC.md](SPEC.md)。

## 旧 npm 许可标识复核（2026-10-15）

基础标识检查只对下列精确版本接受原发布方的 `MIT/X11` 标识，不扩展通用 allowlist，
不把标识视为完整上游许可文本。升级版本或许可字段变化后重新阻断。

- `buffers@0.1.1`：npm 包缺少许可字段。原作者在
  [固定提交](https://github.com/bitpay/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87)
  为同一版本补充 `license: MIT/X11`。该提交的 `index.js` 与当前冻结安装的发布包逐字节一致；
  SHA-256 为 `97801e296ba5f3c32242f647e1daac5917e300367fed7935ab1e62f40adb1b8a`。
  原始 metadata 快照保存在 `upstream/buffers-0.1.1-package.json`，SHA-256 为
  `eb42a43d5b685e6de2f2f4a5e18a70255be72349def7eedf504b912dd908913e`。
- `chainsaw@0.1.0`：冻结安装的 npm 包自身声明 `MIT/X11`；保留原始 metadata 快照
  `upstream/chainsaw-0.1.0-package.json`，不覆盖发布方字段。

这两个包由表格解析构建依赖引入；当前生产依赖图未包含它们。若以后进入发行产物，
仍须收集该版本的完整许可原文。现有 `reviewRequired` 材料缺口继续保留，严格检查不得绕过。
