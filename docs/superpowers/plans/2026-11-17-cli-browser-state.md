# CLI Browser State Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `zcode --browser-use=headless` 在每个 session 创建 BrowserContext 时注入只读的 Playwright storage state 文件；来源是 `--browser-state <path>`，或自动加载的默认文件，可用 `--no-browser-state` 关闭。

**Architecture:** adapters 新增 `storage-state.ts`，负责读取、zod 校验、统计和告警，CLI 启动校验和 adapter 每个 session 的读取共用它。CLI 入口解析来源，在创建 app/session 之前失败；adapter 在 `ensureSession` 里把解析后的对象传给 `newContext`。进程模型、session 隔离和生命周期都不变。

**Tech Stack:** TypeScript (ESM)、zod 4（adapters 已依赖 `zod@4.6.5`）、playwright-core 1.59.1、vitest（adapters / browser-use-plugin）、node:test（cli）。

**Spec:** `docs/browser-use/2026-11-17-cli-browser-state-spec.md`（上位：`docs/browser-use/2026-07-13-cli-headless-cdp-backend-spec.md`）。

## Global Constraints

- 工作目录：本特性的 worktree，分支 `feat/cli-browser-state`。下面的命令都从 worktree 根目录执行。
- 参数：`--browser-state <path>`（string）、`--no-browser-state`（boolean）；只能和 `--browser-use=headless` 一起用，两者互斥。
- 默认文件：`<home>/.zcode/cli/browser-state.json`；`<home>` 与 `os.homedir()` 同一规则：Windows 取 `env.USERPROFILE`，其他平台取 `env.HOME`，为空时回退 `os.homedir()`（最终审查修正，见 spec §4）。
- 相对路径按 CLI 启动目录 `(deps.cwd ?? process.cwd)()` 解析，在 `--cwd` 覆盖 `commandDeps.cwd` 之前取值。
- 所有参数和文件错误：退出码 1，发生在 app/session 创建前，不发模型请求，不启动 Chromium。
- 未开 headless 时不访问任何登录态文件。
- 不新增环境变量，不新增配置文件键。
- 错误信息和日志不得包含 cookie、localStorage、IndexedDB 的值；adapter 返回给模型的错误不含文件路径；日志只记录来源类型和数量，不记录路径。
- 三类启动提示（默认文件已加载、未知字段、权限过宽）在所有入口写 stderr，同时写 `deps.logger`（info/warn）。
- 已知字段（未知字段告警的判断依据）：顶层 `cookies`、`origins`；cookie `name`、`value`、`url`、`domain`、`path`、`expires`、`httpOnly`、`secure`、`sameSite`、`partitionKey`、`_crHasCrossSiteAncestor`；origin `origin`、`localStorage`、`indexedDB`；localStorage 项 `name`、`value`。
- 文件 I/O 只用异步 `fs/promises`，只出现在 CLI 入口层和 adapters。
- 字符串常量提取为具名常量；新代码不加注释，只有非显然约束才写一行中文注释。
- 测试与文档只用 `example.com` 域名和 `/Users/dev` 之类的示例路径。

## Review Focus

1. 用 Windows 编辑器保存的文件带 UTF-8 BOM：应该正常加载，不报 JSON 无效。→ Task 1 测试 `strips a UTF-8 BOM`。
2. Playwright 导出的 `expires` 是小数（如 `1795000000.5`）：应该通过校验。→ Task 1 测试 `loads a Playwright-exported file`。
3. 用户写 `--browser-state=~/state.json`（`=` 形式，shell 不展开 `~`）：应该报错退出，并显示解析后的绝对路径，让用户看出问题。→ Task 3 测试 `reports the resolved path when an explicit file is missing`。
4. 默认路径是一个目录：按"默认文件存在但无效"处理，报错退出并提示 `--no-browser-state`。→ Task 3 测试 `fails closed when the default path is a directory`。
5. Windows 上不做权限检查：`platform: "win32"` 时即使 mode 是 0644 也不告警。→ Task 1 测试 `skips the permission check on win32`。

---

### Task 1: 登录态文件加载器

**Files:**

- Create: `apps/zcode-cli/packages/adapters/src/browser/storage-state.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/browser/index.ts`（文件末尾 re-export）
- Test: `apps/zcode-cli/packages/adapters/tests/browser-storage-state.test.ts`

**Interfaces:**

- Consumes: 无。
- Produces（从 `@zcode/adapters/browser` 导出）:

  ```ts
  export function resolveDefaultBrowserStatePath(env: NodeJS.ProcessEnv): string;
  export type BrowserStorageState = {
    cookies?: BrowserStateCookie[];
    origins?: BrowserStateOrigin[];
  }; // z.infer
  export type BrowserStateFileErrorCode =
    | "missing"
    | "not_file"
    | "unreadable"
    | "invalid_json"
    | "invalid_schema";
  export class BrowserStateFileError extends Error {
    readonly name: "BrowserStateFileError";
    readonly code: BrowserStateFileErrorCode;
    readonly path: string; // 绝对路径；不进入 message
    readonly issues: readonly string[]; // 仅 invalid_schema：字段位置，如 "cookies[0].sameSite"
  }
  export interface BrowserStateLoadResult {
    state: BrowserStorageState; // 已剔除未知字段
    summary: { cookieCount: number; expiredCookieCount: number; originCount: number };
    unknownFields: string[]; // 去重、按出现顺序，如 "cookies[].sourcePort"
    looseMode?: number; // POSIX 且 (mode & 0o077) !== 0 时为 mode & 0o777
  }
  export async function loadBrowserStorageState(
    path: string,
    options?: { platform?: NodeJS.Platform | string; nowMs?: () => number },
  ): Promise<BrowserStateLoadResult>;
  ```

- [ ] **Step 0: 准备 worktree 依赖和构建产物**

Run: `pnpm install && pnpm --dir apps/zcode-cli build`
Expected: 安装和构建成功。CLI 各包的测试和 typecheck 依赖上游包的 `dist`，dist 陈旧会造成大量假失败。

- [ ] **Step 1: 写失败测试 `browser-storage-state.test.ts`**

每个用例在 `mkdtemp` 目录里写文件。用例和断言：

- `loads a Playwright-exported file`：两条 cookie（`.example.com`，`expires: 1795000000.5`，`sameSite: "Lax"`，带 `partitionKey` 和 `_crHasCrossSiteAncestor: false`；另一条 `expires: -1`），一个 origin `https://app.example.com`（2 条 localStorage，`indexedDB: []`）→ `state` 深等于输入；`summary` 为 `{ cookieCount: 2, expiredCookieCount: 0, originCount: 1 }`；`unknownFields` 为 `[]`。
- `counts expired cookies`：一条 `expires: 1000`，`nowMs: () => 2_000_000` → `expiredCookieCount === 1`。
- `strips a UTF-8 BOM`：内容以 `\uFEFF` 开头 → 正常加载。
- `classifies file errors`：不存在 → `code === "missing"`；路径中间段是普通文件（ENOTDIR）→ `"missing"`；目录 → `"not_file"`；`"{"` → `"invalid_json"`。
- `reports schema issues by field location`：分别构造 `sameSite: "lax"`、同时有 `url` 和 `domain`、没有 `url` 也没有 `domain`/`path`、`expires: 0`、origin `"https://app.example.com/"`、origin `"file:///tmp"` → `code === "invalid_schema"`，`issues` 分别包含 `cookies[0].sameSite`、`cookies[0]`、`cookies[0]`、`cookies[0].expires`、`origins[0].origin`、`origins[0].origin`。
- `never leaks values or the path in error messages`：cookie value 为 `"secret-cookie-value"` 的 schema 错误文件 → `error.message` 和 `String(error)` 都不包含 `"secret-cookie-value"` 和文件路径。
- `collects unknown fields`：顶层 `version`、cookie `sourcePort`、origin `sessionStorage`、localStorage 项 `extra` → `unknownFields` 等于 `["version", "cookies[].sourcePort", "origins[].sessionStorage", "origins[].localStorage[].extra"]`；返回的 `state` 不含这些字段。
- `reports loose POSIX permissions`（`it.skipIf(process.platform === "win32")`）：chmod 0o644 → `looseMode === 0o644`；chmod 0o600 → `looseMode` 为 `undefined`。
- `skips the permission check on win32`：0o644 文件 + `platform: "win32"` → `looseMode` 为 `undefined`。
- `resolves the default path like os.homedir on each platform`：同时设置 `HOME` 和 `USERPROFILE` 时，darwin 以 `HOME` 为根、win32 以 `USERPROFILE` 为根；`{}` 以 `os.homedir()` 为根。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/browser-storage-state.test.ts`
Expected: FAIL，找不到 `../src/browser/storage-state.js`。

- [ ] **Step 3: 实现 `storage-state.ts`**

- schema 用 zod `looseObject` 解析，再用 Global Constraints 里的已知字段列表计算 `unknownFields`，最后输出只含已知字段的 `state`。
- cookie 规则和 Playwright `addCookies` 一致：`url` 与 `domain`/`path` 二选一（有 `url` 时不能有 `domain` 或 `path`；没有 `url` 时 `domain` 和 `path` 都必须有）；`expires` 为 `-1` 或大于 0 的数；`sameSite` 只能是 `Strict`/`Lax`/`None`。
- origin 规则：`new URL(origin)` 的 protocol 是 `http:` 或 `https:`，并且 `.origin === origin`。
- `indexedDB` 只校验是数组，元素用 `z.unknown()` 透传。
- zod issue 的 path 转成 `cookies[0].sameSite` 形式；cookie 级别的规则失败记为 `cookies[0]`。
- 先 `stat`（跟随符号链接）：ENOENT/ENOTDIR → `missing`；非普通文件 → `not_file`；其他错误 → `unreadable`。读取后去掉开头的 `\uFEFF` 再 `JSON.parse`。
- 每种 code 的 message 用具名常量，例如 `"Browser state file was not found"`，不包含路径和值。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/browser-storage-state.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/zcode-cli/packages/adapters/src/browser/storage-state.ts apps/zcode-cli/packages/adapters/src/browser/index.ts apps/zcode-cli/packages/adapters/tests/browser-storage-state.test.ts
git commit -m "feat(adapters): load and validate browser storage state files"
```

### Task 2: adapter 在每个 session 注入登录态

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/src/browser/index.ts`（`ManagedCdpBrowserRuntimeOptions` 约 :24；`ensureSession` 约 :236-268）
- Modify: `apps/zcode-cli/packages/adapters/src/browser/request.ts`（`classifyError`）
- Test: `apps/zcode-cli/packages/adapters/tests/browser.test.ts`（扩展 `createFakePlaywright`，约 :353）

**Interfaces:**

- Consumes: Task 1 的 `loadBrowserStorageState`、`BrowserStateFileError`。
- Produces: `ManagedCdpBrowserRuntimeOptions.storageStatePath?: string`（绝对路径）。

- [ ] **Step 1: 写失败测试**

先让 `createFakePlaywright` 的 `newContext(options)` 把收到的 options 记进返回值的 `contextOptions` 数组。新增用例：

- `creates contexts without storageState when no state path is configured`：`contextOptions[0]` 没有 `storageState`，并且仍是 `acceptDownloads: false`、`viewport: { width: 1280, height: 720 }`。
- `injects the storage state into every session context`：写一个有效文件；session-a、session-b 各执行一次 `newTab` → 两个 `contextOptions[i].storageState` 都深等于文件内容。
- `rereads the state file for each new session context`：session-a 建好后改写文件（cookie value 改变），再建 session-b → 两次注入的 value 不同。
- `fails a session with backend_unavailable while the state file is invalid and recovers once fixed`：文件写成 `"{"`；session-c `newTab` → `ok === false`、`error.code === "backend_unavailable"`，`error.message` 不含文件路径；`fake.contexts` 数量不变。把文件修好，同一个 session-c 再执行 `newTab` → `ok === true`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/browser.test.ts`
Expected: 新用例 FAIL（`storageState` 未注入，错误码为 `execution_error`）。

- [ ] **Step 3: 实现**

- `ensureSession` 在 `browser.newContext` 之前：配置了 `storageStatePath` 时调用 `loadBrowserStorageState` 取 `state`，作为 `storageState` 传入；没配置时不传这个键。读取失败直接抛出：现有的 `#sessionPromises` finally 会清掉失败的 promise，同一 session 下一次请求会重新读取。
- `classifyError`：在正则判断之前，`error instanceof BrowserStateFileError` 返回 `"backend_unavailable"`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --dir apps/zcode-cli/packages/adapters exec vitest run tests/browser.test.ts tests/browser-storage-state.test.ts`
Expected: PASS

- [ ] **Step 5: 构建 adapters 并提交**

Run: `pnpm --dir apps/zcode-cli/packages/adapters build`（CLI 通过 `@zcode/adapters/browser` 读 dist）

```bash
git add apps/zcode-cli/packages/adapters/src/browser/index.ts apps/zcode-cli/packages/adapters/src/browser/request.ts apps/zcode-cli/packages/adapters/tests/browser.test.ts
git commit -m "feat(adapters): inject browser storage state into session contexts"
```

### Task 3: CLI 参数、来源解析与接线

**Files:**

- Modify: `apps/zcode-cli/packages/shared-types/src/index.ts`（`GlobalOptions`，约 :30）
- Modify: `apps/zcode-cli/packages/cli/src/arguments.ts`（约 :24-29）
- Create: `apps/zcode-cli/packages/cli/src/browser-state-option.ts`
- Modify: `apps/zcode-cli/packages/cli/src/run.ts`（`--browser-executable` 校验约 :412；scope 检查约 :499-508 之后）
- Modify: `apps/zcode-cli/packages/cli/src/headless-browser.ts`
- Modify: `apps/zcode-cli/packages/cli/src/tui-command.ts`（约 :41-55）、`apps/zcode-cli/packages/cli/src/tui-prompt-handler.ts`（约 :53-67、:153）
- Modify: `apps/zcode-cli/packages/i18n/src/locales/en-US.ts`、`zh-CN.ts`（帮助文本，约 :35 之后）
- Test: Create `apps/zcode-cli/packages/cli/tests/browser-state-option.test.ts`；Modify `apps/zcode-cli/packages/cli/package.json` 的 `test` 脚本，加入该文件

**Interfaces:**

- Consumes: Task 1 的 `resolveDefaultBrowserStatePath`、`loadBrowserStorageState`、`BrowserStateFileError`；Task 2 的 `storageStatePath`。
- Produces:

  ```ts
  // shared-types
  export type GlobalBrowserStateSelection = { source: "explicit" | "default"; path: string };
  // GlobalOptions 新增：browserState?: GlobalBrowserStateSelection   （缺省 = 不注入）

  // cli/src/browser-state-option.ts
  export const BROWSER_STATE_REQUIRES_HEADLESS_ERROR =
    "--browser-state and --no-browser-state require --browser-use=headless.";
  export const BROWSER_STATE_CONFLICT_ERROR =
    "--browser-state cannot be used with --no-browser-state.";
  export function validateBrowserStateFlags(input: {
    browserUse: GlobalOptions["browserUse"];
    explicitPath: string | undefined;
    disabled: boolean;
  }): string | undefined; // 同步，返回错误文案或 undefined
  export async function resolveBrowserStateSelection(input: {
    explicitPath: string | undefined;
    disabled: boolean;
    launchCwd: string;
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform | string;
  }): Promise<
    | {
        ok: true;
        selection?: GlobalBrowserStateSelection;
        notices: string[];
        logSummary?: BrowserStateLoadResult["summary"];
      }
    | { ok: false; error: string }
  >;
  // createTuiSubmitPrompt 新增最后一个位置参数：browserState?: GlobalOptions["browserState"]
  ```

- [ ] **Step 1: 写失败测试 `browser-state-option.test.ts`**

参照 `tests/workflow-mode-option.test.ts` 的 `createContext` 和假 deps。用 `deps.env = { HOME: <临时目录> }` 控制默认路径，用 `deps.cwd = () => <临时目录>` 控制启动目录；`createManagedCdpBrowserRuntime` 替身记录收到的 `storageStatePath`。用例：

- `does not touch any state file without --browser-use=headless`：HOME 下放一个无效默认文件，跑普通 `--prompt` → 退出码 0。
- `rejects state flags without headless`：`--browser-state x.json --prompt p` 和 `--no-browser-state --prompt p` → 退出码 1，stderr 等于 `BROWSER_STATE_REQUIRES_HEADLESS_ERROR + "\n"`，没有调用 `createZCodeApp`。
- `rejects both state flags together` → 退出码 1，stderr 含 `BROWSER_STATE_CONFLICT_ERROR`。
- `keeps app-server rejecting headless browser flags`：`["app-server", "--browser-use=headless", "--browser-state", <无效文件>]` → 退出码 1，stderr 是现有的 `--browser-use=headless can only be used with --prompt, --target, or tui.`，不是文件错误（说明没有读取文件）。
- `passes no state path when the default file is absent` → `storageStatePath` 为 `undefined`，stderr 为空。
- `loads the default file and prints a notice` → `storageStatePath` 等于 `<HOME>/.zcode/cli/browser-state.json`；stderr 含 `"Loaded default browser state"` 和 `"--no-browser-state"`。
- `skips the default file with --no-browser-state`：默认文件内容无效 → 退出码 0，`storageStatePath` 为 `undefined`。
- `resolves an explicit relative path against the launch directory`：`--cwd` 指向另一个目录，`--browser-state ./state.json` 相对启动目录 → `storageStatePath` 等于 `<launchCwd>/state.json`。
- `reports the resolved path when an explicit file is missing`：`--browser-state=~/missing.json` → 退出码 1，stderr 含 `join(launchCwd, "~", "missing.json")`，没有调用 `createManagedCdpBrowserRuntime` 和 `createZCodeApp`。
- `fails closed when the default file is invalid`：默认文件为 `"{"` → 退出码 1，stderr 含默认文件路径和 `"--no-browser-state"`。
- `fails closed when the default path is a directory` → 同上。
- `prints schema issues without values`：cookie value 为 `"secret-cookie-value"`、`sameSite: "lax"` → 退出码 1，stderr 含 `cookies[0].sameSite`，不含 `"secret-cookie-value"`。
- `warns about unknown fields and loose permissions`（POSIX 才跑权限部分）：文件含 `cookies[].sourcePort`，chmod 0o644 → 退出码 0；stderr 含 `"cookies[].sourcePort"` 和 `"chmod 600"`。
- `passes the selection into the TUI browser runtime`：`["tui", "--browser-use=headless", "--browser-state", <file>]`，`runTui` 替身通过 `options.loadStartupOptions` 触发首个 app 创建 → `storageStatePath` 等于该文件的绝对路径。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --dir apps/zcode-cli/packages/cli exec node --disable-warning=DEP0205 --import tsx --test tests/browser-state-option.test.ts`
Expected: FAIL（参数未知，或缺少 `browser-state-option.js`）。

- [ ] **Step 3: 实现**

- `arguments.ts`：新增 `"browser-state": { type: "string" }`、`"no-browser-state": { type: "boolean" }`。
- `run.ts`：在 `--browser-executable` 校验之后调用 `validateBrowserStateFlags`，有错误就写 stderr 并返回 1。在 `BROWSER_USE_SCOPE_ERROR` 检查之后、`resolveCliCwd` 之前，`browserUse === "headless"` 时调用 `resolveBrowserStateSelection`，其中 `launchCwd` 取 `(deps.cwd ?? process.cwd)()`，`env` 取已有的 `env` 变量。失败时写 stderr 并返回 1；成功时逐行写 `notices` 到 stderr，用 `deps.logger` 记录来源类型和 `logSummary`，并设置 `options.browserState = selection`。
- `browser-state-option.ts`：文件错误的 stderr 文案 = `error.message` + `: <path>`；`invalid_schema` 时追加 ` (fields: <issues 用 ", " 连接>)`；`source` 为默认文件时再追加一句 `Fix the file or pass --no-browser-state.`。默认文件得到 `missing` 时视为未选择，不报错。提示文案用具名常量：默认文件已加载、未知字段（列出 `unknownFields`）、权限过宽（显示八进制 mode 和 `chmod 600 <path>`）。
- `headless-browser.ts`：`options` 的 Pick 加上 `browserState`，传 `storageStatePath: options.browserState?.path`。
- TUI：`tui-command.ts` 把 `options.browserState` 作为 `createTuiSubmitPrompt` 的最后一个参数；`tui-prompt-handler.ts` 新增同名最后一个参数，并在 :153 一起传给 `createCliHeadlessBrowserRuntime`。
- i18n：两份帮助文本在 `--browser-executable` 之后各加两行：
  - en-US：`--browser-state <path> Playwright storage state injected into headless Browser Use sessions`、`--no-browser-state Skip the default browser state file (~/.zcode/cli/browser-state.json)`
  - zh-CN：`--browser-state <path> 注入 headless Browser Use 会话的 Playwright 登录态文件`、`--no-browser-state 不加载默认登录态文件（~/.zcode/cli/browser-state.json）`

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --dir apps/zcode-cli/packages/shared-types build && pnpm --dir apps/zcode-cli/packages/cli exec node --disable-warning=DEP0205 --import tsx --test tests/browser-state-option.test.ts`
Expected: PASS

- [ ] **Step 5: 跑 CLI 全量测试、typecheck、lint**

Run: `pnpm --dir apps/zcode-cli/packages/cli test && pnpm --dir apps/zcode-cli typecheck && pnpm --dir apps/zcode-cli lint`
Expected: 全部通过。已有的 `cli.unit.test.ts` headless 用例不受影响。

- [ ] **Step 6: 提交**

```bash
git add apps/zcode-cli/packages/shared-types/src/index.ts apps/zcode-cli/packages/cli apps/zcode-cli/packages/i18n/src/locales
git commit -m "feat(cli): add --browser-state and default browser state loading"
```

### Task 4: 真实浏览器 E2E、文档定稿与人工验收

**Files:**

- Modify: `apps/zcode-cli/packages/browser-use-plugin/test/headless-browser.e2e.test.ts`
- Modify: `apps/zcode-cli/docs/usage/02-cli-reference.md`（约 :29）
- Modify: `docs/browser-use/2026-11-17-cli-browser-state-spec.md`（状态行与 §12）

**Interfaces:**

- Consumes: Task 2 的 `storageStatePath`。

- [ ] **Step 1: 写 E2E 用例 `injects storage state through MCP js and the managed CDP backend`**

沿用现有用例的 broker、MCP client 和 `realBrowserTest` 骨架。新 fixture server：`/` 返回的页面把 `document.cookie` 和 `localStorage.getItem("token")` 写进 `#cookie`、`#token` 两个元素。服务端从不设置 cookie，所以页面上出现 cookie 只能来自注入。在临时目录生成 state 文件：cookie `{ name: "sid", value: "e2e-cookie", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }`；origin 是 fixture 的 origin，localStorage `token = "e2e-token"`。`createManagedCdpBrowserRuntime({ executablePath, storageStatePath })` 后，通过 `js` 打开 fixture，读取两个元素的文本。断言输出含 `"sid=e2e-cookie"` 和 `"e2e-token"`。

- [ ] **Step 2: 运行真实浏览器链路**

Run: `pnpm --dir apps/zcode-cli test:browser-headless`
Expected: 两个用例都 PASS（需要本机有 Chrome/Chromium）。

- [ ] **Step 3: 更新文档**

- `02-cli-reference.md`：在 `--browser-use=headless` 一条后补充 `--browser-state <path>`、`--no-browser-state` 和默认文件位置，并说明可以用 `playwright open --save-storage <file> <url>` 生成文件。
- spec：状态改为"已实现"；§12 记录实际改动的文件、测试用例数和 E2E 结果。

- [ ] **Step 4: 架构与开源检查**

Run: `pnpm architecture:check --changed && node opensource/tools/check-competitor-terms.mjs docs/browser-use/2026-11-17-cli-browser-state-spec.md apps/zcode-cli/docs/usage/02-cli-reference.md`
Expected: 通过；竞品词 0 处。

- [ ] **Step 5: 提交**

```bash
git add apps/zcode-cli/packages/browser-use-plugin/test/headless-browser.e2e.test.ts apps/zcode-cli/docs/usage/02-cli-reference.md docs/browser-use/2026-11-17-cli-browser-state-spec.md
git commit -m "test(browser-use): cover storage state injection end to end"
```

- [ ] **Step 6: 人工验收 BST-012（需要用户参与）**

用户用 `node node_modules/playwright-core/cli.js open --channel chrome --save-storage <0700 目录>/state.json <需要登录的站点>` 登录后关闭窗口。然后运行构建后的 CLI：`zcode --browser-use=headless --browser-state <file> --prompt "打开 <目标页面> 并告诉我页面标题"`。期望：回答里是目标页面的标题，不是登录页。把结果记入 spec §12（不写内部域名），之后删除 state 文件。
