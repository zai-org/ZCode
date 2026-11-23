# 预装工具资源制作

合同见 [通用规格](../../docs/preinstalled-tools/README.md) 与 [LibreOffice 规格](../../docs/preinstalled-tools/libreoffice.md)。工具只制作资源和发布条目，不安装系统软件、不上传 CDN、不修改 App catalog。

## 公共层

`common/` 是所有转换器共用的制作边界：

| 模块                             | 责任                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `inputs.mjs`                     | 固定 URL、大小、SHA-256 的下载缓存，隔离 GPG 验签，外部命令执行   |
| `archive.mjs`                    | 安全相对链接、固定顺序/权限/时间、流式 tar.gz 与摘要              |
| `schema.mjs`                     | 加载 App 的公共资源契约，不复制一份 schema                        |
| `structures.mjs`、`binaries.mjs` | Mach-O、ELF、PE 结构；macOS ≤ 13.0、GLIBC ≤ 2.28、程序架构        |
| `provenance.mjs`                 | 已核对来源的原始文件摘要快照、`LICENSES/` 与 `SOURCES.json` 汇总  |
| `paths.mjs`                      | 本次打包路径、未声明的重定位占位符、逐文件上游路径豁免            |
| `package.mjs`                    | 核对磁盘身份/必需文件/公共门禁后生成归档与未发布描述              |
| `publish.mjs`                    | 接受两组发布地址，生成一个 catalog 工具条目                       |
| `conda*.mjs`                     | 固定 conda 输入、安全解包、前缀元数据、原始来源、导入表闭包与裁剪 |
| `source-member.mjs`              | 从 ZIP 或 tar.gz 只提取指定上游文件，保留边界和大小限制           |

转换器先完成输入校验与平台转换，写入与 recipe 一致的 `zcode-tool-resource.json`，收集许可/来源，再调用 `packageResource`。`resource` 使用 `platforms`、`binaryArch`、`entries`、`runtimeChecks` 和嵌套的 `archive`。未发布描述没有下载地址，`validation.runtime` 固定为 `not-run`；二进制结构通过不表示目标平台运行通过。

`SOURCES.json` 为组件列表，每项保存 `component`、固定来源 `url`、`sha256` 和包内 `licenses` 路径。LibreOffice 记录官方安装包、完整验签指纹 `signingFingerprint` 以及官方源码归档；未修改字体记录固定提交中的原始字体；MSI 内 VC++ 运行库保留官方分发来源，另外的 `provenance.runtime.origin` 区分 MSI 与显式补充输入。GPL 源码归档的 CDN 存档属于发布步骤。

### 构建路径门禁

- 本次资源树、制作工作目录、输入缓存、输出目录、用户主目录及用户名路径段始终禁止。同时检查原始路径、JSON 转义、POSIX 写法和 file URL。
- 全部声明的 `rewrite` 占位符以及已知 conda 占位符只能出现在相应声明文件。扫描保留跨块前缀，不因二进制中的 NUL 或 UTF-8 路径而截断。
- recipe 的 `upstreamBuildPaths` 每项是 `{prefix, source}`；prefix 是非根目录的绝对上游构建路径前缀，source 是对应已核对来源的输入 URL。来源核对接受官方签名或 recipe 固定的摘要。常见构建根与这些显式前缀均扫描。
- 转换器必须在来源核对成功、原始树尚未改写时调用 `captureVerifiedFiles`，记录每个原始文件的摘要与输入来源。只有该文件当前位置、当前字节和来源均匹配时，上游前缀才可豁免。
- 资源视图、配置、约束文件、`LICENSES/` 等生成或新增文件不进入原始文件快照。上游例外不能覆盖本机路径或未声明的重定位占位符。
- 生成的 `.pyc` 只在需要继承已声明上游前缀时单独审计。转换器传入包内相对 `pycInterpreter`；公共层核对对应 `.py` 的原始来源、摘要和前缀，再用资源解释器、固定优化级别、`unchecked-hash` 与实际生效的 `PYTHONHASHSEED=0` 独立重编译，比较完整字节。任何一项不符都列出文件并失败。其他生成文件不适用；未改动的上游 pyc 继续按原始字节核对。
- 静态扫描不证明可重定位运行；还要经过运行检查和含空格、中文目录的安装验收。

## LibreOffice 转换器

配方位于 `libreoffice/recipes/`，固定安装包、分离签名、字体、许可证及源码归档摘要。已有输入先核对大小与摘要；缺失输入使用有大小上限的下载，缓存以同目录硬链接原子发布，不覆盖先完成的输入。工具没有跳过签名的开关。

```sh
node scripts/preinstalled-tools/libreoffice/convert.mjs \
  --recipe scripts/preinstalled-tools/libreoffice/recipes/libreoffice-26.8.1-darwin-arm64.json \
  --input-dir inputs --output-dir artifacts --public-key release-key.asc
```

`inputs`、`artifacts` 应放在仓库外。GPG 在独立临时 keyring 中验证固定完整指纹 `C2839ECAD9408FBE9531C3E9F434A1EFAFEEAEA3`，不修改用户的 GPG 配置。指纹来源见 [官方发布工程说明](https://lists.freedesktop.org/archives/libreoffice/2015-February/066756.html)。

- macOS 使用系统 `hdiutil`、`codesign`、`lipo`。原 `.app` 复制前后验签，保持封存不变；独立 `resource-base` 以包内相对链接提供随包字体。入口按资源定义设置品牌资源 URL 与默认 `osx` 后端。
- Windows 使用 `msiextract`、`msiinfo`、`gcab`。VC++ DLL 按签名 MSI 的 File/Media 身份从 CAB 提取并核对 PE 架构、普通/延迟导入闭包；不根据 System64 目录猜测架构，不覆盖不同的原文件。选中的 DLL 以 MSI 地址和选取时的摘要登记进原始文件快照，其中微软构建机的 PDB 路径仍须在 recipe 声明并逐字节核对。
- Linux 只提取 deb 的数据归档，不运行 maintainer scripts。入口必须为匹配架构的 ELF；全部 ELF 的 GLIBC 门禁由公共层执行。系统共享库与目标平台运行仍需另验。

每次制作使用新输出目录。比较两次 `.tar.gz` 的字节数和 SHA-256，证明确定性；工具拒绝覆盖已有归档或描述。正式 catalog 仍需法务、CDN 发布与真实运行验收。

## 发布条目

```sh
node scripts/preinstalled-tools/common/publish.mjs \
  --artifact artifacts/resource.artifact.json --display-name LibreOffice \
  --out catalog-entry.json
```

命令按资源身份写入 `archive.path`（`<toolId>/<resourceId>/<resourceId>.tar.gz`），不接受下载地址参数。下载基址由 App 决定，见规格的“下载地址”；上传时把归档放在每个基址下的同一路径。输出只是条目文件，不上传。

工程验证：

```sh
pnpm test:engineering scripts/preinstalled-tools/common scripts/preinstalled-tools/libreoffice
```

小型夹具验证门禁与确定性，不代替官方签名、字体、文档转换、宏、安装路径和其他操作系统的真实验收。

## conda 公共边界与 qpdf

```text
固定包名 / 版本 / build / URL / SHA-256
  → prepareCondaPackages（核对后解开 .conda 或 tar.bz2，不执行脚本）
  → assembleCondaPrefix（唯一候选前缀与原始来源快照）
  → resolveCondaClosure（入口 → 导入表 → 库与符号链接）
  → recipe.files（一次求解，写入审阅后的锁）
  → writeCondaPayload（只保留锁内内容、对应 rewrite、许可与来源）
  → packageResource（所有公共门禁 → 归档）
```

`info/paths.json` 与旧 `info/files` / `info/has_prefix` 都受支持。两个前缀来源同时存在时核对一致；保留文件的全部前缀进入 `rewrite`，裁剪掉的 pkgconfig 等文件不会留下悬空声明。包内渲染过的 `rendered_recipe.yaml` 或 `meta.yaml` 提供源码 URL 与摘要；新版 rattler 的 `finalized_sources` 与 `finalized_cache_sources` 合并记录最终来源，只有没有最终来源时才读取 recipe 的 source 字段；许可文本从 `info/licenses/`（旧包为 `info/license.txt`）汇总。`licenseFiles` 可显式列出包内 `share/licenses/` 等载荷许可；`extraLicenses` 可补充固定官方 URL、大小、SHA-256 的完整许可输入。两者进入 `LICENSES/`，额外输入随 recipe 和产物来源保留。缺少许可仍拒绝，不能用 `info/recipe/LICENSE` 的构建脚本许可替代运行库许可。

conda v2 的 NSS 等官方输入可能把 `info/licenses/` 下的普通许可文件放入载荷分卷。公共解包器只在此路径允许普通文件跨分卷；路径安全、大小限制与不覆盖已有文件的规则保持不变。载荷分卷中的索引、recipe、链接等其他元数据仍拒绝。许可不因此成为运行载荷；仍按包的文件清单裁剪，并单独汇总到 `LICENSES/`。

conda 包输入可用 `sourceArchives` 显式补充原 HTTP 源码的 HTTPS 资产，每项仍使用固定 `filename`、`url`、`sizeBytes`、`sha256`。URL 只允许原地址的同 host/path/query 协议升级，SHA 必须等于包内原 recipe；`prepareCondaPackages` 实际核对缓存或下载。未知、未核验或摘要不符的替换拒绝。`writeCondaPayload` 返回 `sourceArchiveVerifications`，转换器将原 HTTP 地址与已核对 HTTPS 资产写入产物 provenance，`SOURCES.json` 只使用后者。

输入缓存按包摘要分区，避免不同平台同名包互相覆盖。`.inputs.json` 仅是固定来源清单，**不是已制作的资源**。先按实际二进制解析闭包，再审阅上游诊断前缀声明；缺库、锁漏文件或运行库架构不符都拒绝。系统库只按各目标系统的明确边界识别，不使用制作机器已安装的库补洞。

```sh
node scripts/preinstalled-tools/qpdf/resolve.mjs \
  --inputs scripts/preinstalled-tools/qpdf/recipes/qpdf-12.4.2-linux-x64.inputs.json \
  --input-dir inputs --out qpdf-linux.recipe.json
node scripts/preinstalled-tools/qpdf/convert.mjs \
  --recipe qpdf-linux.recipe.json --input-dir inputs --output-dir artifacts
```

`resolve` 只生成新文件，不覆盖已审阅 recipe；闭包锁不等于结构或运行验收。qpdf 转换器要求 `files` 与实际传递闭包相同，不把头文件、静态库、文档或额外命令带进资源。

## Pandoc 转换器

每个平台的 recipe 固定官方二进制归档和同版本 Hackage 源码归档，只提取 `pandoc` 与 `COPYRIGHT`。macOS 要求 Apple 锚定且 Team ID 与 recipe 相符，二进制不改写。其他平台只检查结构，不通过宿主仿真执行。Windows x64 资源的 `platforms` 同时包含 Windows arm64。

```sh
node scripts/preinstalled-tools/pandoc/convert.mjs \
  --recipe scripts/preinstalled-tools/pandoc/recipes/pandoc-3.1.12.2-darwin-arm64.json \
  --input-dir inputs --output-dir artifacts
```

未发布描述的 `provenance.sourceArchives` 保存需随 GPL 资源存档的源码输入；发布上传仍属于发布阶段。首次发现旧发布资产没有公开 SHA-256 时，先按固定官方 URL 与大小取得输入并核对来源/签名，建立摘要后才写入 recipe；生产转换入口没有跳过摘要的模式。

Pandoc 正文对照样例由 `pandoc/fixtures/create_samples.py`（python-docx）生成，固定文档属性和 ZIP 时间。使用 Heading1 表示正文标题。Word 的 Title 样式被 Pandoc 读作 `meta.title`，默认非 standalone 的 plain/markdown 不渲染该元数据；这项既有边界与正文完整性分别记录，不能以正文样例推断所有 Word 样式都完整。

### 非运行二进制模板

Recipe 的 `architectureExceptions` 逐项填写 `path`、`sha256`、`source`、`purpose`。路径必须精确，不接受通配符；只声明与 `binaryArch` 不匹配的 PE 数据文件。不存在、摘要不符、来源不符、不需要例外或属于入口、运行检查、rewrite、导入表可达依赖时，制作失败。

转换器必须在官方签名或 recipe 固定摘要核对成功后捕获原始文件摘要，并通过 `checkedSourceFiles` 传给公共层。诊断构建路径与架构模板使用同一份原始文件来源与摘要快照，不维护两套来源事实。生成的文件不在此快照内。架构例外仅跳过 PE 架构一致性；许可、来源、路径、重定位和二进制结构检查保持执行。

依赖保护读取 PE 普通及延迟导入、Mach-O dylib 命令和 ELF DT_NEEDED，保守地将同名本地候选都视为可达。动态加载用途仍需审阅 recipe 的来源与用途声明。当前 LibreOffice 的 macOS arm64 与 Linux x64 recipe 各自只列入已核对的十个不匹配模板；其他目标在实际重产时需按其上游输入逐项核对，不能直接照抄架构例外。

## Poppler 转换器

Poppler 与 poppler-data 的输入锁沿用 conda 公共工具。四个入口为 `pdftoppm`、`pdftotext`、`pdfimages`、`pdfinfo`；完整 recipe 的 `files` 必须恰好等于四入口的传递库闭包与 poppler-data 的 `share/poppler/` 文件树，少文件或多带一个命令都拒绝。Windows x64 的同一资源可以声明 Windows arm64，其他平台必须使用本机架构。

```sh
node scripts/preinstalled-tools/poppler/resolve.mjs \
  --inputs scripts/preinstalled-tools/poppler/recipes/poppler-26.10.0-darwin-arm64.inputs.json \
  --input-dir inputs --out poppler-mac.recipe.json
node scripts/preinstalled-tools/poppler/convert.mjs \
  --recipe poppler-mac.recipe.json --input-dir inputs --output-dir artifacts
```

转换器生成 `etc/fonts/fonts.conf`，不复制 conda 的宿主配置或额外 include。字体只来自系统和用户目录；Windows 使用 fontconfig 的 `WINDOWSFONTDIR`、`WINDOWSUSERFONTDIR` 解析机制；缓存使用 `prefix="xdg"`。四个入口都设置 `FONTCONFIG_FILE`。文件改写仍来自实际保留文件的 conda 元数据，生成的配置不继承上游路径例外。两项版本检查使用 `-v`，通用安装器核对 stdout 与 stderr 的合并输出。

`provenance.sourceArchives` 保存所有保留组件的上游源码地址、摘要和许可引用，供发布阶段存档；转换器不上传。PP-01 固定样例可用 `poppler/fixtures/create_cid_sample.py` 生成。生成器用 pypdf 解析实际字体、内容流与字符编码，确认是无嵌入字体、无 ToUnicode 的 `UniGB-UCS2-H` PDF；它的结构证明不代替经已安装入口执行的 Poppler 文本与视觉验收。

### 目录前缀的固定字节槽

资源 rewrite 的模式为 text、binary、binary-dir-prefix。前两者保留既有语义。需要保留编译时字符串长度的目录前缀，由 recipe 的 binaryDirPrefixFiles 逐个列出精确相对文件路径；不接受通配符。conda 元数据不会自动升级模式，selectDirectoryPrefixRewrites 只把所列文件已有的单条 binary 声明改成新模式；缺失、text 声明或重复选择都拒绝。

packageResource/validateResource 同时接收 binaryDirPrefixFiles，核对它与新模式文件逐项对应、不是 Windows 资源、每处占位符后继为 /、NUL 或 EOF。制作门禁与安装器复用共享 Node 纯字节算法。新模式仅把占位槽换成安装目录并用 / 补足原宽度，不移动后缀，不写 NUL；UTF-8 路径超长仍为 unsupported，原 binary 仍在字符串末尾补 NUL。App 的文件 IO、取消、重签和发布事务保持原 owner，不移入工程工具。
