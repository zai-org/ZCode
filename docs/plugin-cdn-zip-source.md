# CDN Zip Plugin Source 安装设计

## 1. Goals / non-goals

### Goals

- 支持 marketplace plugin entry 指向 CDN 托管的 `.zip` 插件包，并复用现有安装闭环：
  `installMarketplacePlugin` -> `cacheMarketplacePlugin` -> `resolvePluginSourceRoot` -> 拷贝到
  `~/.zcode/cli/plugins/cache/{marketplace}/{plugin}/{version}/` -> 写入
  `installed_plugins.json`。
- 在 plugin entry 现有 `{ "source": "url" }` 上新增显式 artifact type：
  `{ "source": "url", "type": "zip", ... }`。无 `type` 的 `{ "source": "url" }`
  继续保持 legacy git clone 语义；不要靠 URL 后缀推断 zip。
- 下载、校验、解压后仍返回 plain directory tree。最终安装产物继续是包含
  `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`
  的目录，不长期保留 zip archive。
- 下载链路要对齐现有 marketplace/git 网络出口策略。现有 git 子进程通过
  `buildMarketplaceGitEnv()` 和 `applyNetworkEgressEnv()` 注入 `ZCODE_HTTP_PROXY` 等显式网络环境；
  zip 下载应使用同一网络出口语义，而不是绕过代理配置。
- 保持 Claude Marketplace Git 兼容性。本 Phase 1 原本不改变 `github`、`git`、`url`、
  `git-subdir`；后续 [公开 GitHub 插件源无 Git安装规格](./plugin-github-archive-source.md)
  已将可匿名读取的 GitHub HTTPS 来源收敛到同一安全 ZIP materializer，其他来源仍走系统 Git。
  `npm` / `pip` 仍是识别但不安装的诊断路径。
- 在 spec 先行的基础上，给后续 coding agent 留出具体文件、测试和 rollout checklist。

### Non-goals

- Phase 1 不支持 marketplace 本身以 zip 分发。现有 marketplace source 的 `"url"` 继续表示
  HTTP fetch `marketplace.json`，这是和 plugin entry source 不同的轴。
- Phase 1 不实现 zip 内 package manager 安装，不执行 `npm install` / `pip install`。
- Phase 1 不改变 plugin runtime、启用态、MCP/hook 安全策略，也不把任何业务状态下沉到 Electron
  main process、relay 或 web remote 链路。
- Phase 1 不实现自动 update daemon；只扩展现有 overview/update 检测使用的 pin 读取能力。
- Phase 1 不引入新的缓存布局，不把 zip 文件作为长期缓存 key 或安装产物。

## 2. Source schema

新增 plugin entry URL artifact type：

```json
{
  "name": "cdn-plugin",
  "version": "1.2.3",
  "description": "Install from CDN zip",
  "source": {
    "source": "url",
    "type": "zip",
    "url": "https://cdn.example.com/zcode/plugins/cdn-plugin-1.2.3.zip",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "path": "packages/cdn-plugin",
    "stripRoot": true
  }
}
```

字段语义：

| 字段 | Phase 1 语义 |
| --- | --- |
| `source` | 固定为 `"url"`。这是 plugin entry source，不是 marketplace source。 |
| `type` | zip artifact 必填为 `"zip"`。缺失或 `"git"` 时保持 legacy git clone。未知值直接诊断/报错，不 fallback。 |
| `url` | 必填，远端 CDN 必须是 `https://` URL。本地测试/fixture 允许 loopback HTTP（`localhost` / `127.0.0.1` / `::1`）。 |
| `sha256` | zip source 必填，64 位小写 hex。下载后必须先校验 digest，校验通过才允许解压。 |
| `path` | 可选，zip 解压后的插件子目录。语义对齐 git source 的 `path`，先安全解压到临时根，再在临时根内 `resolveInside(path)` 定位插件根。 |
| `headers` | 可选，仅允许普通字符串 header；禁止 `Authorization`、`Cookie` 等敏感 header 进入 marketplace JSON。Phase 1 建议仅支持公开 CDN，不把 credential 写入 marketplace。 |
| `stripRoot` | 可选布尔值。`true` 表示 zip 所有条目都有同一个安全顶层目录时，定位 root 时可剥离这一层；默认推荐 `true`，但实现要和 `path` 互斥或明确优先级。 |

推荐的最小公开 CDN entry：

```json
{
  "name": "superpowers-cdn",
  "source": {
    "source": "url",
    "type": "zip",
    "url": "https://cdn.example.com/plugins/superpowers.zip",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

带子目录的 monorepo zip entry：

```json
{
  "name": "atomic-agents",
  "source": {
    "source": "url",
    "type": "zip",
    "url": "https://cdn.example.com/archives/agents-bundle.zip",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "path": "claude-plugin/atomic-agents"
  }
}
```

不采用无 `type` 的 `{ "source": "url", "url": "https://...zip" }` 的原因：

- 当前 plugin entry `{source:"url"}` 在 `resolvePluginSourceRoot()` 中进入
  `resolveGitPluginSource()`，会 clone `source.url`。
- 当前 marketplace source `{source:"url"}` 在 `loadMarketplaceFromSource()` 中才是
  `fetch(source.url)` 并解析 JSON。两个 `"url"` 属于不同层级，继续混用会破坏 Claude
  marketplace 兼容和用户心智。
- 因此 zip 必须显式写成 `{source:"url", type:"zip"}`。禁止通过 `.zip` 后缀猜测类型，
  因为 CDN 签名 URL 和无后缀 artifact URL 都很常见。

### Marketplace URL 文件名与 JSON 契约

- marketplace URL 的文件名不参与类型判断。`marketplace.json`、`index.json` 或无扩展名 URL
  都通过现有 marketplace URL fetch 路径下载并解析 JSON。
- 响应内容继续使用现有 marketplace manifest 格式，顶层直接包含合法 `name` 和 `plugins`；
  `description`、`owner`、`description_i18n` 等扩展字段可按现有宽松解析规则保留在 raw manifest 中。
- 不新增 `{ "marketplace": { "name": "..." }, "plugins": [...] }` envelope 兼容。CDN 发布端必须输出
  现有格式，避免客户端同时维护两个同义 schema。
- plugin artifact 的 zip 文件名同样不参与判断。客户端只依据 plugin entry 的
  `{ "source": "url", "type": "zip" }` 分发，并使用 `sha256` 验证下载内容。

官方 CDN marketplace 可直接使用：

```json
{
  "name": "zcode-plugins-official",
  "description": "Official ZCode plugins marketplace",
  "plugins": [
    {
      "name": "example-plugin",
      "version": "0.1.1",
      "source": {
        "source": "url",
        "type": "zip",
        "url": "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/example-plugin/0.1.1/plugin.zip",
        "sha256": "5e93c44a9a3c292d6c59688d76874d9035ff740486390612c5daf13566d4049b",
        "path": "example-plugin"
      }
    }
  ]
}
```

入口 URL 为 `https://cdn-zcode.z.ai/zcode/official-plugin/index.json`。示例中的版本和 digest
仅表示发布时快照；客户端 smoke 测试应从 overview 读取 live 版本，避免 CDN 增量发布造成硬编码漂移。

## 3. Install pipeline steps

当前安装链路事实：

- `installMarketplacePlugin()` 先确保 marketplace manifest 可用，再解析 dependency closure。
- 每个 entry 进入 `cacheMarketplacePlugin()`。
- `cacheMarketplacePlugin()` 调用 `resolvePluginSourceRoot()` 得到 `{ path, cleanup? }`。
- 然后读取插件 root 的 manifest version，计算 cache 目录，`rm target` 后 `cp sourceRoot.path`
  到 cache，最后写入安装记录。
- `validateMarketplacePlugin()`、`describeMarketplacePlugin()` 和 marketplace source validate
  也会调用 `resolvePluginSourceRoot()`；因此 zip resolver 必须是临时目录 + cleanup 合约，不能只为安装路径服务。

Phase 1 zip 安装步骤：

1. `installMarketplacePlugin({ marketplace, name })` 保持不变，找到目标 `PluginMarketplaceEntry`。
2. `cacheMarketplacePlugin()` 保持不变，调用 `resolvePluginSourceRoot({ entry, ... })`。
3. `resolvePluginSourceRoot()` 在 `sourceKind === "url"` 分支按 `source.type` 分发：
   - `url` 缺失、不是字符串或为空时立即报错；显式 object source 的字段错误不得继续走
     `localByName` fallback。
   - `type` 缺失或 `"git"`：继续调用现有 `resolveGitPluginSource()`。
   - `type === "zip"`：进入 zip 下载/解压安装路径。
   - 其他 `type`：报 unsupported/invalid source。
   - 校验 `url` / `sha256` / `path` / `headers` / `stripRoot` shape。
   - 调用 `resolveZipPluginSource({ url, sha256, path, headers, stripRoot, signal })`。
4. `resolveZipPluginSource()` 创建临时目录，例如 `mkdtemp(join(tmpdir(), "zcode-plugin-zip-"))`。
5. 下载 zip 到临时文件或流式写入临时文件：
   - 使用与 marketplace 操作一致的 AbortSignal。
   - 对齐 `ZCODE_HTTP_PROXY` / `ZCODE_HTTPS_PROXY` / `ZCODE_NO_PROXY` / CA 等网络出口配置。
   - 记录累计下载字节，超过上限立即 abort 并删除临时目录。
6. 计算下载内容 SHA-256：
   - 若 entry 提供 `sha256`，实际 digest 必须完全相等。
   - 若策略允许缺失 `sha256`，仍计算 digest 并仅用于日志/诊断/update pin。
7. 安全解压 zip 到临时 extract root：
   - 逐 entry 校验路径，拒绝绝对路径、`..`、反斜杠、Windows drive、空 path、NUL path。
   - 拒绝 symlink、device、socket 等非普通文件/目录。
   - 逐 entry 统计 uncompressed bytes、文件数、目录数、单文件大小，超限失败。
8. 定位插件 root：
   - 若 `path` 存在：使用 `resolveInside(extractRoot, path)`，要求目录存在。
   - 否则若 `stripRoot === true` 或默认启用 root detection：当所有解压条目共享一个顶层目录时，使用该顶层目录。
   - 否则使用 `extractRoot`。
   - 定位后的 root 交给现有 `validatePluginRoot()` / `resolveInstalledPluginVersion()`，必须找到合法 plugin manifest，除非 entry `strict:false` 走现有 synthetic manifest 规则。
9. `resolveZipPluginSource()` 返回 `{ path: pluginRoot, cleanup }`。cleanup 使用有限重试；失败路径必须保留
   下载、校验或解压的原始错误，并把 cleanup failure 作为附加诊断。
10. `cacheMarketplacePlugin()` 继续按现有逻辑复制 plain directory 到：

```text
~/.zcode/cli/plugins/cache/{marketplace}/{plugin}/{version}/
```

11. cache 复制成功后的 source cleanup 是 best-effort；cleanup failure 不得阻断安装记录构造和
    `saveInstalledPlugins()`，避免 cache 与 `installed_plugins.json` 分裂。
12. `ensureMarketplaceEntryManifest()`、安装记录 `source` 回写、`saveInstalledPlugins()` 都沿用当前逻辑。安装记录中的 `source` 应保留完整 zip source object，便于后续 `sha256` update pin 比较。

## 4. Security requirements

### HTTPS

- Phase 1 远端 CDN 默认只允许 `https://`。`http://` 仅允许 loopback host（`localhost`、`127.0.0.1`、`::1`）用于本地模拟真实 URL 的 fixture 和开发验证。
- URL 必须可被 `new URL()` 解析，禁止 `file://`、`data:`、`blob:`、`ftp:`。
- 跟随 redirect 时最终 URL 也必须是 `https://`；redirect 次数设上限。

### Headers

- `headers` 只允许普通字符串键值。
- 默认拒绝敏感 header：`authorization`、`cookie`、`proxy-authorization`、`set-cookie`。
- redirect 仅在目标 URL 与当前 URL 同 origin 时继续发送自定义 `headers`；跨 origin redirect
  必须清除全部自定义 `headers`，不能依赖敏感 header denylist 防止信息泄露。
- Phase 1 推荐只支持公开 CDN。需要私有 CDN 时，应先设计 credential store 集成，不能把 token 写进 marketplace JSON。

### Network egress

- ZIP 下载必须使用 adapters 的 web-fetch 网络出口语义：显式 `ZCODE_HTTP_PROXY` / `ZCODE_NO_PROXY`
  优先，并回退读取 `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` 中封存的用户 `HTTP_PROXY` / `HTTPS_PROXY` /
  `NO_PROXY`。
- 不能直接使用只识别显式 ZCode proxy 的默认 HTTP resolver；否则 agent 清理标准代理变量后，git source
  可以安装而 ZIP source 会尝试直连。
- CA、timeout、下载大小限制和 AbortSignal 继续由共享 HTTP adapter 处理，不在 plugin 层重复实现。

### Integrity

- `sha256` 作为安全默认必填，格式为 64 位 hex，比较前统一小写。
- 缺失 `sha256` 时 install 阻断，validate 返回明确 diagnostic，提示 manifest 必须提供 `sha256`。
- 校验必须发生在解压前。digest mismatch 时不得解压、不得写 cache、不得写 install record。
- 下载失败、校验失败、解压失败时必须清理临时目录。
- 临时目录删除至少进行有限次数重试。最终仍失败时，原始业务错误保持为主错误；安装成功路径不得因
  cleanup failure 回滚或跳过 installed record。

### Zip Slip / unsafe entry

- zip entry path normalization 可参考 `packages/services/src/skill-sync/skillSyncPath.ts` 的思路：
  拒绝绝对路径、`..`、反斜杠、Windows drive、空段，并用 `relative(targetRoot, targetPath)`
  再确认目标仍在 extract root 内。
- 不能只依赖 yauzl 的 path 字符串；写文件前必须自己做 containment。
- 对 zip directory entry 和 file entry 分别处理。拒绝 symlink 和特殊文件；如果库无法可靠暴露 external attrs，
  Phase 1 保守策略是只写普通 file entry 和 directory entry，其他类型失败。

### Size limits

建议常量放在 adapters plugin zip helper 内：

```ts
const ZIP_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const ZIP_EXTRACT_MAX_BYTES = 250 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 20_000;
const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
```

默认值可按产品调整，但必须有：

- compressed download 上限；
- uncompressed extracted bytes 上限；
- entry count 上限；
- 单文件上限；
- 临时目录 cleanup。

### Network / proxy

- 现有 git clone 使用 `execGitCommand()`，其 env 来自 `buildMarketplaceGitEnv()` ->
  `sanitizeZCodeRuntimeEnv()` -> `applyNetworkEgressEnv()`。
- zip 下载不走 git 子进程，不能自然继承这套 env；实现应新增一个 fetch dispatcher/proxy-agent
  适配点，或抽出共享 network egress helper，让 HTTP zip download 与 marketplace/git 网络策略一致。
- `@zcode/adapters` 已依赖 `proxy-agent`，可优先用它构造 Node fetch dispatcher；具体 API 需要 coding
  阶段按当前 Node/undici 类型验证，不在 spec 中假设不存在的调用签名。

## 5. Update detection changes

当前更新检测事实：

- `apps/zcode-cli/packages/bootstrap/src/plugins.ts` 构建 `latestPinByPluginId` 时读取
  `entry.version` 和 `readPluginSourceSha(entry.source)`。
- `comparePluginUpdate()` 的优先级是：
  1. latest version 存在 -> semver/version compare；
  2. 否则 latest sha 存在 -> sha identity compare；
  3. 否则 -> `none`。
- `readPluginSourceSha()` 当前只读取 `source.sha`，兼容 `source.commit`。

zip 设计：

- 保持 version primary：当 marketplace entry 有 `version`，仍以 version 作为 update 轴。
- 当 entry 无 `version` 但 zip source 有 `sha256`，用 `sha256` 作为内容完整性 pin 和 update identity。
- 为避免把 git commit sha 与 zip sha256 混成一个含义，建议新增更通用的 helper：

```ts
readPluginSourcePin(source): { kind: "git-sha" | "zip-sha256"; value: string } | undefined
```

Phase 1 为最小改动，也可以扩展现有 `readPluginSourceSha()`：

- 对 git/url/github/git-subdir 返回 `sha` / `commit`；
- 对 zip 返回 `sha256`；
- 注释明确该值是“source identity pin”，不再只表示 git sha。

推荐最终取名：`readPluginSourceIdentityPin()`，再同步更新 `bootstrap/src/plugins.ts` 和
`version-compare.ts` 的参数名，减少后续误读。

安装记录：

- `cacheMarketplacePlugin()` 当前会把 `input.entry.source` 原样写入 `InstalledPluginRecord.source`。
  因此 zip 安装后 record 可保留 `source.sha256`，供下次 overview 比较。
- 如果允许缺失 `sha256`，安装记录可记录实际下载 digest 作为内部字段，但这会改变 record schema。
  Phase 1 推荐不新增持久字段：缺失 `sha256` 的 entry 不提供 update pin，只能依赖 `version`。

## 6. Files/modules to touch

必须修改：

- `docs/plugin-cdn-zip-source.md`
  - 本 spec，随实现更新决策和验收结果。
- `docs/claude-code-marketplace-plugin-compat.md`
  - 在 plugin entry source 矩阵新增 `{source:"url", type:"zip"}`。
  - 明确无 `type` 的 `{source:"url"}` 仍是 git clone 兼容路径，不代表 HTTP zip。
- `apps/zcode-cli/packages/adapters/package.json`
  - `@zcode/adapters` 当前没有 `yauzl`；若采用 yauzl，需要在 adapters 自己声明 dependency。
  - 仓库已有 `yauzl`：`packages/desktop/package.json` 和 `packages/services/package.json` 均依赖
    `yauzl` / `@types/yauzl`，但不能跨 package 隐式使用。
- `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts`
  - `PluginMarketplaceEntry.source` 仍是 `unknown`，但 `sourceKind === "url"` 需要按 `source.type` 分发。
  - 新增 `readPluginSourceIdentityPin()` 或扩展/重命名 `readPluginSourceSha()`。
  - `validateMarketplaceEntryShape()` 新增 zip shape 和 integrity diagnostic。
  - `getMarketplaceSourceValidationDeferral()` 可把 zip 也视为 remote plugin source，在 marketplace-level
    validate 时 deferral，避免批量下载数百个 zip。
- `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts`（建议新文件）
  - `resolveZipPluginSource()`、download、sha256、safe extract、root locate。
  - 保持 marketplace.ts 体积可控。
- `apps/zcode-cli/packages/adapters/src/plugins/index.ts`
  - 如新增 public helper 或测试需要导出，更新 barrel。
- `apps/zcode-cli/packages/adapters/src/network/subprocess-env.ts` 或相邻 network helper
  - 抽出 HTTP fetch/proxy 对齐逻辑，避免 zip 下载绕过 `ZCODE_HTTP_PROXY` 等网络策略。
- `apps/zcode-cli/packages/bootstrap/src/plugins.ts`
  - update overview 的 latest/installed pin 读取从 git sha 扩展到 zip sha256。
- `apps/zcode-cli/packages/adapters/src/plugins/version-compare.ts`
  - 如果保留字符串 pin，逻辑可不变但命名/注释要更新；如果区分 pin kind，更新类型和测试。

必须新增/更新测试：

- `apps/zcode-cli/packages/adapters/tests/plugins.test.ts`
- `apps/zcode-cli/packages/adapters/tests/version-compare.test.ts`
- 如网络/proxy helper 抽出：对应 adapters network 单测。

可能需要修改：

- `pnpm-lock.yaml`
  - adapters 新增 `yauzl` dependency 后会更新。
- `apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts`
  - 如果 overview schema 或 helper 语义在 bootstrap 层暴露，需要补覆盖。

不应修改：

- Electron main process / relay 业务状态。
- web remote task/session realtime 语义。
- plugin cache 布局和 runtime loader 安装产物读取语义。

## 7. Test plan

### Unit: source parsing / validation

- zip source shape valid：
  - `source:"url"`、`type:"zip"`、HTTPS 或 loopback HTTP url、合法 sha256、可选 path、可选 stripRoot。
- zip source invalid：
  - 缺 url；
  - 非 loopback `http://`；
  - `file://`；
  - sha256 非 64 hex；
  - headers 非 object；
  - sensitive headers；
  - `path` 含 `..` / Windows drive / 反斜杠。
- marketplace-level validate 对 remote zip source 返回 `plugin_validation_deferred`，不批量下载。

### Unit: download / integrity

- 下载 zip，sha256 匹配后继续。
- sha256 mismatch：报错，临时目录清理，不写 cache，不写 installed record。
- 下载超过 compressed limit：报错并 abort。
- 支持 AbortSignal：下载中 abort 后清理临时目录。
- cleanup failure：失败路径保留原始错误并附带 cleanup diagnostic；cache 已复制成功时仍写入
  installed record。
- 代理配置测试：仅在 `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` 中提供用户 `HTTP_PROXY`，不设置
  `ZCODE_HTTP_PROXY`，断言 ZIP 请求仍通过本地代理；测试不得访问外网。
- redirect 安全测试：跳转到非 HTTPS、非 loopback URL 时拒绝；跨 origin 跳转时不转发自定义
  `headers`，同 origin 跳转仍可保留普通 header。

### Unit: safe extract fixtures

- 正常 zip：根目录直接包含 `.claude-plugin/plugin.json`。
- 单顶层目录 zip：`plugin-1.0.0/.claude-plugin/plugin.json`，默认 root detection/`stripRoot:true`
  后安装成功。
- 子目录 zip：`bundle/claude-plugin/atomic-agents/.claude-plugin/plugin.json` + `path` 安装成功。
- Zip Slip：
  - `../escape.txt`；
  - `/absolute.txt`；
  - `C:\escape.txt`；
  - `nested/../../escape.txt`；
  - 反斜杠路径。
- 特殊 entry：
  - symlink；
  - device/socket 或未知 type；
  - directory/file 混合。
- limit：
  - entry count 超限；
  - extracted bytes 超限；
  - 单文件超限。

### Unit: install/cache behavior

- `installMarketplacePlugin()` 安装 zip source 后，cache 路径仍是：

```text
cache/{marketplace}/{plugin}/{version}/
```

- 安装记录 `source` 保留 `{source:"url", type:"zip", url, sha256, ...}`。
- zip plugin manifest version 优先于 marketplace entry version 的现有规则保持不变。
- `describeMarketplacePlugin()` 对未安装 zip plugin 可临时下载/解压/枚举组件，并 cleanup。
- `validateMarketplacePlugin()` 对单个 zip plugin 深扫 root。

### Unit: update detection

- entry 有 `version` 和 `sha256`：version 轴优先，sha256 变化但 version 相同 -> `none`。
- entry 无 `version`，installed/source sha256 与 latest/source sha256 不同 -> `update-available`。
- latest 有 sha256，installed 无 sha256 -> `version-changed`。
- 无 version、无 sha256 -> `none` 或 warning，按产品决策固定。
- git `sha` / `commit` 现有测试保持通过，证明没有破坏 Claude official git path。

### Desktop E2E: startup seed + service install + discover

- pending manual-review spec：
  `packages/desktop/test/e2e/plugins/installation/plugin-cdn-zip-marketplace-install.test.ts`。
- WDIO `beforeSession` 在 Electron 启动前启动 loopback zip fixture server，并把 zip marketplace seed 到
  `<E2E_HOME>/.zcode/cli/plugins/known_marketplaces.json` 与
  `<E2E_HOME>/.zcode/cli/plugins/marketplaces/{marketplace}/marketplace.json`。
- spec 通过 renderer `window.__testActions` 调用真实 `zcodeAgentService.installPlugin()`，覆盖
  desktop renderer -> services -> agent protocol -> bootstrap -> adapters 的安装链路。
- 断言范围：
  - install 前 overview 可见 seeded marketplace 和 zip plugin；
  - install 后 `cache/{marketplace}/{plugin}/{version}` 已 materialize；
  - `installed_plugins.json` 保留 `{source:"url", type:"zip", url, sha256}`；
  - `config.json#plugins.enabledPlugins[id] === true`；
  - `listPlugins()` discover 出 command/skill 组件。

### Desktop E2E: official CDN smoke

- pending manual-review spec：
  `packages/desktop/test/e2e/plugins/installation/manual-review/pending/plugin-cdn-zip-official-cdn-smoke.test.ts`。
- 这两个用例验证插件安装，不涉及 conversation/session 状态机，因此登记在 plugin 专项目录，不进入
  conversation case catalog 和 coverage matrix。
- 通过真实 `addPluginMarketplace()` 添加官方 `index.json`，随后走真实
  `installPlugin()` 和 `listPlugins()` 服务入口。
- 版本从 add 后的 overview 动态读取，不在测试中固定 CDN 发布版本；安装成功同时证明 manifest
  可解析且 zip 的 `sha256` 与下载内容一致。
- 断言 cache、`installed_plugins.json`、enabled config 和 command/skill discover。
- 此用例依赖公网与官方 CDN 当前内容，只作为 manual smoke，不进入离线 replay/CI 稳定套件；确定性 CI
  覆盖由 loopback seed 用例承担。

### Fixture strategy

- 测试 zip 通过测试 helper 动态创建，不依赖外部 CDN。
- 如果采用 `yauzl` 只读解压，可用现有测试依赖生成 zip；若没有 zip writer，测试可引入轻量 dev helper 或使用仓库已有 archive builder，但不要让 production helper 依赖 test-only API。
- 所有 zip fixture 都必须跨 macOS/Linux/Windows 路径语义稳定。

## 8. Rollout phases

### Phase 1 minimal

- 新增 plugin entry `{source:"url", type:"zip"}`。
- 远端 CDN HTTPS only，本地 fixture 允许 loopback HTTP。
- `sha256` required。
- 安全下载、sha256 校验、安全解压、root locate。
- 复用 `resolvePluginSourceRoot()` -> `{ path, cleanup? }` -> `cacheMarketplacePlugin()`。
- 更新 `docs/claude-code-marketplace-plugin-compat.md` source matrix。
- 单元测试覆盖 install、validate、describe、update detection、zip slip、limits。
- 不改 marketplace-as-zip。
- 不改 runtime 和 UI 业务语义；UI 只自然展示现有 install/diagnostic 结果。

### Phase 2 hardening

- 私有 CDN credential 方案：headers 不直接写 marketplace JSON，改走 credential store 或 marketplace trust policy。
- 更细的 trust policy：官方/企业 marketplace 可配置是否允许缺失 sha256、允许哪些 CDN host。
- 内容寻址临时下载缓存：短期复用相同 `{url, sha256}`，但仍最终 materialize 到现有 cache 目录。
- 支持 `.zip` marketplace source 需要单独 spec：marketplace-as-zip 是另一条轴，不能和 plugin zip source 混做。
- zip 签名或 manifest 签名验证。
- UI 侧展示 integrity 状态、digest mismatch 诊断、下载大小。
- 网络代理集成补 e2e 或集成测试，覆盖企业代理/自签 CA。

## 9. Open questions / decisions for product owner

1. `sha256` 是否硬性必填？
   - 推荐默认：第三方 marketplace 必填；官方/开发 fixture 可 warning。
   - 影响：硬性必填安全性最好，但会阻断只给 CDN URL 的临时市场。

2. `stripRoot` 默认值是什么？
   - 推荐默认：自动检测单一顶层目录并使用该目录；显式 `stripRoot:false` 时使用 extract root。
   - 影响：多数 GitHub release zip 都有一个顶层目录，默认自动剥离能减少 manifest author 配置。

3. `headers` Phase 1 是否支持？
   - 推荐默认：支持非敏感公开 header，拒绝敏感 header。
   - 影响：能支持 CDN cache/control header，但不打开 token 明文入口。

4. 缺失 `sha256` 的 update detection 怎么展示？
   - 推荐默认：不提供 identity pin，只能依赖 `version`；若也无 version，显示无可比较更新。
   - 影响：避免把下载时实际 digest 写入 installed record 造成 schema 迁移。

5. zip root 中同时有多个 plugin manifest 怎么处理？
   - 推荐默认：没有 `path` 时只接受 extract root 或单一顶层目录下的一个插件 root；多个候选时报错，要求 marketplace entry 写 `path`。
   - 影响：避免安装错插件。

6. 是否允许 `http://localhost` 测试源？
   - 决策：允许 loopback HTTP，用于模拟真实 ZIP URL 拉取；非 loopback HTTP 仍禁止。
   - 影响：测试可以覆盖真实 HTTP URL 下载链路，同时不放开远端明文 CDN。

## 10. Implementation task checklist

- [ ] 阅读并保持本 spec 与 `docs/claude-code-marketplace-plugin-compat.md` 一致。
- [ ] 在 adapters 增加 zip dependency：优先评估 `yauzl`，并在 `apps/zcode-cli/packages/adapters/package.json`
  显式声明，不依赖 desktop/services 的 transitive dependency。
- [ ] 新建 `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts`：
  - [ ] `resolveZipPluginSource(input): Promise<ResolvedPluginSourceRoot>`；
  - [ ] HTTPS URL 和 redirect 校验；
  - [ ] headers allow/deny list；
  - [ ] download byte limit + AbortSignal；
  - [ ] sha256 digest；
  - [ ] yauzl lazy entry safe extract；
  - [ ] Zip Slip / Windows path / symlink / special entry 拒绝；
  - [ ] extracted size / entry count / single file limit；
  - [ ] root locate: `path`、single top-level、extract root；
  - [ ] cleanup on every failure path。
- [ ] 抽出或新增 HTTP network egress helper，让 zip download 与 `buildMarketplaceGitEnv()` 语义对齐。
- [ ] 修改 `marketplace.ts`：
  - [ ] `resolvePluginSourceRoot()` 在 `sourceKind === "url"` 分支按 `type` 分发；
  - [ ] `validateMarketplaceEntryShape()` 增加 zip shape diagnostics；
  - [ ] `getMarketplaceSourceValidationDeferral()` 把 zip 归入 remote deferral；
  - [ ] 将 `readPluginSourceSha()` 重命名/扩展为 identity pin helper。
- [ ] 修改 `bootstrap/src/plugins.ts` 使用 identity pin helper，确保 zip sha256 进入 update overview。
- [ ] 修改 `version-compare.ts` 注释/类型，保持 version primary、identity pin secondary。
- [ ] 更新 `docs/claude-code-marketplace-plugin-compat.md` 的 plugin source 矩阵。
- [ ] 新增 adapters 单测：
  - [ ] valid zip install；
  - [ ] zip `path` install；
  - [ ] single top-level root detection；
  - [ ] sha256 mismatch；
  - [ ] Zip Slip variants；
  - [ ] size/entry limits；
  - [ ] validate/describe cleanup；
  - [ ] update detection via sha256；
  - [ ] git url/sha existing behavior regression。
- [ ] 运行窄验证：
  - [ ] `pnpm --filter @zcode/adapters test -- plugins.test.ts`
  - [ ] `pnpm --filter @zcode/adapters test -- version-compare.test.ts`
  - [ ] `pnpm --filter @zcode/adapters typecheck`
  - [ ] `pnpm --filter @zcode/adapters lint`
- [ ] 按仓库要求运行全局：
  - [ ] `pnpm typecheck`
  - [ ] `pnpm lint`
- [ ] 提交 Conventional Commits commit，commit body 说明：
  - [ ] 影响面：plugin marketplace install/validate/describe/update overview；
  - [ ] 安全边界：HTTPS、sha256、Zip Slip、size limits；
  - [ ] 未覆盖项：marketplace-as-zip、private CDN credential、UI integrity display。
