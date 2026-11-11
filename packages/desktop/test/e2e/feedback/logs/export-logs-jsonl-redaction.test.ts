// 导出日志后，JSONL（model-io 回放、CLI 日志）每行仍是合法 JSON，且密钥不出现在归档中。
// 根因：导出脱敏曾用文本正则直接改 JSON 文本，替换结果带未转义引号或裸占位符，整行无法解析。
// 正式用例（2026-11-09 由 manual-review/pending 转正），不发模型请求。单独运行：
//   pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/feedback/logs/export-logs-jsonl-redaction.test.ts'
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_TASK_SETTINGS_BUTTON, TID_WORKSPACE_HELP_MENU_TRIGGER } from "@zcode/shared/test-ids";
import yauzl from "yauzl";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

const ROLLOUT_FILE = "model-io-e2e-redaction.jsonl";
// 解析不了的文本行（app/CLI 文本日志）走另一套规则，单独放一个文件覆盖。
const RAW_LOG_FILE = "e2e-redaction-raw.log";
const REDACTED = "***REDACTED***";
// 纯数字口令：敏感键下的数字必须脱敏，且归档里其它位置不会出现这串数字。
const NUMERIC_SECRET = 123456;
// 连接串口令里的引号、反斜杠是内容而不是 JSON 语法。标记串本身不含特殊字符，
// 在 JSONL 里不会因为转义而躲过 includes 检查。
const CONNECTION_PASSWORD_MARKERS = {
  single: "e2e-conn-pw-single",
  double: "e2e-conn-pw-double",
  backslash: "e2e-conn-pw-backslash",
  rawSingle: "e2e-conn-pw-raw-single",
  rawEscaped: "e2e-conn-pw-raw-escaped",
  rawDoubleQuotes: "e2e-conn-pw-raw-double-quotes",
};
// 原始文本里的其它凭据形态：query 值带两个双引号、敏感键下的对象值、带反斜杠的 Bearer。
const RAW_TEXT_MARKERS = {
  query: "e2e-raw-query-token",
  object: "e2e-raw-object-secret",
  bearer: "e2e-raw-bearer-token",
};
// 凭据放在对象键里（连接串、带 token 的 URL、Bearer）：键也要按值形态脱敏。
const KEY_MARKERS = {
  connection: "e2e-key-conn-pw",
  query: "e2e-key-query-token",
  bearer: "e2e-key-bearer-token",
};
// 敏感父字段下以凭据为键的对象：键本身就是凭据，没有连接串、URL、Bearer 之类的形态。
const SENSITIVE_PARENT_KEY_MARKERS = {
  map: "e2e-sensitive-map-key",
  array: "e2e-sensitive-array-key",
  collideA: "e2e-sensitive-collide-key-a",
  collideB: "e2e-sensitive-collide-key-b",
};
// 顶层是 JSON 字符串的行，内层凭据被转义过一次。
const TOP_LEVEL_STRING_MARKER = "e2e-top-level-string-password";
// 需要重写的行里：超过 2^53 的整数、`1.50` 这类写法和 `__proto__` 键必须原样保留。
const PRESERVED_LITERALS_MARKER = "e2e-preserved-literals-password";
// 超深 JSONL 行里的敏感值：整行被换成占位行，原值不能进归档。
const DEEP_JSON_MARKER = "e2e-deep-json-password";
const DEEP_JSON_LEVELS = 5000;
// 敏感父字段下的大对象：所有键都脱敏成同一个占位符，序号分配若逐个从头试是 O(n²)，
// 这一行就会让主进程同步卡住几十秒，导出等不到归档（下面的 30 秒导出上限即耗时预算）。
const LARGE_SENSITIVE_KEY_PREFIX = "e2e-large-sensitive-key-";
const LARGE_SENSITIVE_KEY_COUNT = 30_000;
const SECRETS = [
  "e2e-secret-token-value",
  "e2e-query-key-value",
  "e2e-bearer-token-value",
  "e2e-nested-api-key",
  "e2e-db-password",
  ...Object.values(CONNECTION_PASSWORD_MARKERS),
  ...Object.values(RAW_TEXT_MARKERS),
  ...Object.values(KEY_MARKERS),
  ...Object.values(SENSITIVE_PARENT_KEY_MARKERS),
  TOP_LEVEL_STRING_MARKER,
  PRESERVED_LITERALS_MARKER,
  DEEP_JSON_MARKER,
  LARGE_SENSITIVE_KEY_PREFIX,
];
const connectionString = (password: string) => `postgres://admin:${password}@db.example.com/app`;
const REDACTED_CONNECTION_STRING = `postgres://${REDACTED}:${REDACTED}@db.example.com/app`;

// 构造样本，覆盖曾经让行失效的形态：数字计数、对象值、URL query、转义 JSON 里的 Bearer、
// 字符串里嵌套的 JSON、连接串与后续字段；以及敏感键下的数字（直接值、数组元素）。
const ROLLOUT_LINES = [
  {
    usage: {
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 3 },
      prompt_cache_hit_tokens: 4,
    },
    max_output_tokens: 8192,
    maxOutputTokens: 4096,
  },
  { hasAuth: true, authType: null, auth: { scheme: "bearer", token: SECRETS[0] } },
  { url: `https://api.example.com/v1/models?key=${SECRETS[1]}`, status: 200 },
  {
    body: JSON.stringify({ headers: { Authorization: `Bearer ${SECRETS[2]}` } }),
    tail: "end",
  },
  { body: JSON.stringify({ api_key: SECRETS[3], model: "glm" }) },
  { dsnHint: `postgres://admin:${SECRETS[4]}@db.example.com/app`, email: "dev@example.com" },
  { password: NUMERIC_SECRET },
  { token: [NUMERIC_SECRET] },
  // 普通字段里的连接串，口令含单引号 / 双引号 / 反斜杠，分别放在 message、嵌套 JSON 字符串和长文本里。
  { message: connectionString(`ex'${CONNECTION_PASSWORD_MARKERS.single}`), next: "keep" },
  {
    body: JSON.stringify({
      url: connectionString(`ex"${CONNECTION_PASSWORD_MARKERS.double}`),
      model: "glm",
    }),
  },
  {
    message: `failed: ${connectionString(`ex\\${CONNECTION_PASSWORD_MARKERS.backslash}`)} (retry)`,
  },
  {
    [connectionString(KEY_MARKERS.connection)]: { ok: 1 },
    [`https://api.example.com/x?token=${KEY_MARKERS.query}&page=2`]: 1,
    [`Bearer ${KEY_MARKERS.bearer}`]: true,
  },
  JSON.stringify({ password: TOP_LEVEL_STRING_MARKER, model: "glm" }),
  {
    token: { [SENSITIVE_PARENT_KEY_MARKERS.map]: { expiresAt: 12345 } },
    credentials: [{ [SENSITIVE_PARENT_KEY_MARKERS.array]: true }],
    secrets: {
      [SENSITIVE_PARENT_KEY_MARKERS.collideA]: "v1",
      [SENSITIVE_PARENT_KEY_MARKERS.collideB]: "v2",
    },
    plain: { keep: "me", n: 1 },
  },
];
// JSON.stringify 写不出 2^53 以上的整数和 `1.50`，这一行直接写文本。
const PRESERVED_LITERALS_LINE = `{"requestId":9223372036854775807,"ts":1.50,"__proto__":{"a":1},"password":"${PRESERVED_LITERALS_MARKER}"}`;
const LARGE_SENSITIVE_LINE = JSON.stringify({
  token: Object.fromEntries(
    Array.from({ length: LARGE_SENSITIVE_KEY_COUNT }, (_, index) => [
      `${LARGE_SENSITIVE_KEY_PREFIX}${index}`,
      { expiresAt: index },
    ]),
  ),
  n: 1,
});
// 5000 层嵌套：逐层递归会栈溢出、中断整个导出。直接拼文本，测试进程自己不对它做 JSON.stringify，
// 否则 WDIO worker 的栈先溢出。写在 rollout 文件最后一行。
const DEEP_JSON_LINE = `${"[".repeat(DEEP_JSON_LEVELS)}${JSON.stringify({ password: DEEP_JSON_MARKER })}${"]".repeat(DEEP_JSON_LEVELS)}`;

// 原始文本行（解析不了）：
// - 口令含单引号；截断 JSON 里口令含转义的 `\"`，其后的 owner 字段不能被连接串规则吞掉；
// - 口令、query 值含两个未转义的双引号；
// - 敏感键下的对象值（内层键名不敏感），以及值里带反斜杠的 Bearer。
const RAW_LOG_LINES = [
  `[info] connect ${connectionString(`ex'${CONNECTION_PASSWORD_MARKERS.rawSingle}`)} failed`,
  `[info] cfg {"url":"${connectionString(`ex\\"${CONNECTION_PASSWORD_MARKERS.rawEscaped}`)}","owner":"dev@example.com"`,
  `[info] connect ${connectionString(`p"a"s${CONNECTION_PASSWORD_MARKERS.rawDoubleQuotes}`)} failed`,
  `[info] GET https://api.example.com/v1/x?token=p"a"s${RAW_TEXT_MARKERS.query}&page=2`,
  `{"token":{"value":"${RAW_TEXT_MARKERS.object}"},"n":1`,
  `[info] header Bearer ab\\${RAW_TEXT_MARKERS.bearer} sent`,
];

function readZipEntries(archivePath: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("无法打开归档"));
      const entries = new Map<string, string>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("无法读取条目"));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function findEntry(entries: Map<string, string>, suffix: string): string {
  for (const [name, content] of entries) if (name.endsWith(suffix)) return content;
  throw new Error(`归档中没有 ${suffix}`);
}

async function enterWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
      return $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isExisting();
    },
    { timeout: 30_000, timeoutMsg: "首次使用引导关闭后未进入工作区" },
  );
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
}

async function exportLogsFromHelpMenu(): Promise<string> {
  // 只拦截系统文件浏览器，菜单、preload、IPC 与主进程打包脱敏都走真实链路。
  const reveal = await browser.electron.mock("shell", "showItemInFolder");
  await reveal.mockReturnValue(undefined);
  try {
    const triggers = await $$(`[data-testid="${TID_WORKSPACE_HELP_MENU_TRIGGER}"]`);
    for (const trigger of triggers) {
      if (await trigger.isDisplayed()) {
        await trigger.waitForClickable();
        await trigger.click();
        break;
      }
    }
    await $('[role="menu"]').waitForDisplayed();
    // 隔离 HOME 的界面语言不固定，按中英文两种文案定位同一个菜单项。
    for (const item of await $$('[role="menuitem"]')) {
      if (/Export logs|导出日志/.test(await item.getText())) {
        await item.click();
        break;
      }
    }
    await browser.waitUntil(
      async () => {
        await reveal.update();
        return reveal.mock.calls.length === 1;
      },
      { timeout: 30_000, timeoutMsg: "点击导出日志后未生成归档" },
    );
    return String(reveal.mock.calls[0]?.[0]);
  } finally {
    await reveal.mockRestore();
  }
}

describe("导出日志 JSONL 脱敏", () => {
  const homeDir = process.env.ZCODE_E2E_HOME_DIR;
  const rolloutDir = homeDir ? join(homeDir, ".zcode", "cli", "rollout") : "";
  const cliLogDir = homeDir ? join(homeDir, ".zcode", "cli", "log") : "";

  before(async () => {
    if (!homeDir) throw new Error("缺少 ZCODE_E2E_HOME_DIR，无法在隔离 HOME 中放置样本");
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(
      join(rolloutDir, ROLLOUT_FILE),
      `${[
        ...ROLLOUT_LINES.map((line) => JSON.stringify(line)),
        PRESERVED_LITERALS_LINE,
        LARGE_SENSITIVE_LINE,
        DEEP_JSON_LINE,
      ].join("\n")}\n`,
      "utf8",
    );
    await mkdir(cliLogDir, { recursive: true });
    await writeFile(join(cliLogDir, RAW_LOG_FILE), `${RAW_LOG_LINES.join("\n")}\n`, "utf8");
    await enterWorkspace();
  });

  after(async () => {
    if (rolloutDir) await rm(join(rolloutDir, ROLLOUT_FILE), { force: true });
    if (cliLogDir) await rm(join(cliLogDir, RAW_LOG_FILE), { force: true });
  });

  it("ELR-01 每行 JSON.parse 通过，密钥被替换，非敏感上下文保留", async function () {
    this.timeout(90_000);
    const archivePath = await exportLogsFromHelpMenu();
    expect(archivePath).toMatch(/zcode-logs-[^/\\]+\.zip$/);
    const entries = await readZipEntries(archivePath);
    const exported = findEntry(entries, `rollout/${ROLLOUT_FILE}`);

    const lines = exported.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(ROLLOUT_LINES.length + 3);
    const parsed = lines.map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`导出后第 ${index + 1} 行不是合法 JSON：${String(error)}`);
      }
    });
    // 整个归档的所有条目都不能残留模拟凭据，不只检查放样本的文件。
    for (const [name, content] of entries) {
      for (const secret of SECRETS) {
        expect({ name, leaked: content.includes(secret) }).toEqual({ name, leaked: false });
      }
    }
    // 纯数字可能偶然出现在其它条目（pid、耗时）里，只在样本文件里检查。
    expect(exported).not.toContain(String(NUMERIC_SECRET));

    // 计数原样保留（白名单里的 usage 键不能因“敏感键下数字脱敏”被误伤）；
    // 敏感键下的布尔和 null 承载不了凭据，也保留，排障时能看出是否配置。
    expect(parsed[0]).toEqual(ROLLOUT_LINES[0]);
    expect(parsed[1]).toMatchObject({ hasAuth: true, authType: null });
    expect(parsed[2]).toMatchObject({ status: 200 });
    expect(parsed[3]).toMatchObject({ tail: "end" });
    // 嵌套 JSON 字符串脱敏后仍可解析。
    expect(JSON.parse(String(parsed[4]?.body))).toMatchObject({ model: "glm" });
    expect(parsed[5]).toMatchObject({ email: "dev@example.com" });
    // 敏感键下的数字换成字符串占位符，数组元素继承父键的敏感性。
    expect(parsed[6]).toEqual({ password: REDACTED });
    expect(parsed[7]).toEqual({ token: [REDACTED] });
    // 已解码字符串里的引号、反斜杠是口令内容：整段口令脱敏，scheme、host 和相邻字段保留。
    expect(parsed[8]).toEqual({ message: REDACTED_CONNECTION_STRING, next: "keep" });
    expect(JSON.parse(String(parsed[9]?.body))).toEqual({
      url: REDACTED_CONNECTION_STRING,
      model: "glm",
    });
    expect(parsed[10]).toEqual({ message: `failed: ${REDACTED_CONNECTION_STRING} (retry)` });
    // 对象键里的凭据按值形态脱敏，scheme、host 和非敏感部分保留。
    expect(parsed[11]).toEqual({
      [REDACTED_CONNECTION_STRING]: { ok: 1 },
      [`https://api.example.com/x?token=${REDACTED}&page=2`]: REDACTED,
      [`Bearer ${REDACTED}`]: true,
    });
    // 顶层 JSON 字符串行：内层 JSON 按结构脱敏后再编码回字符串。
    expect(JSON.parse(String(parsed[12]))).toEqual({ password: REDACTED, model: "glm" });
    // 敏感父字段下的键也换成占位符（含数组里的对象），重名加序号不互相覆盖；
    // 布尔值照旧保留，非敏感父字段下的普通对象原样不动。
    expect(parsed[13]).toEqual({
      token: { [REDACTED]: { [REDACTED]: REDACTED } },
      credentials: [{ [REDACTED]: true }],
      secrets: { [REDACTED]: REDACTED, [`${REDACTED} (2)`]: REDACTED },
      plain: { keep: "me", n: 1 },
    });
    // 重写的行里数字按原始字面量写回，`__proto__` 键不被原型 setter 吞掉。
    expect(lines[ROLLOUT_LINES.length]).toBe(
      `{"requestId":9223372036854775807,"ts":1.50,"__proto__":{"a":1},"password":"${REDACTED}"}`,
    );
    // 大敏感对象：每个键都换成占位符且序号各不相同，一个都不丢；值照常脱敏，相邻字段保留。
    const largeToken = parsed[ROLLOUT_LINES.length + 1]?.token as Record<string, unknown>;
    const largeKeys = Object.keys(largeToken);
    expect(largeKeys).toHaveLength(LARGE_SENSITIVE_KEY_COUNT);
    expect(largeKeys[0]).toBe(REDACTED);
    expect(largeKeys[LARGE_SENSITIVE_KEY_COUNT - 1]).toBe(
      `${REDACTED} (${LARGE_SENSITIVE_KEY_COUNT})`,
    );
    expect(largeToken[REDACTED]).toEqual({ [REDACTED]: REDACTED });
    expect(parsed[ROLLOUT_LINES.length + 1]).toMatchObject({ n: 1 });
    // 超深的行整行换成仍可解析的说明占位，导出不中断。
    expect(parsed[ROLLOUT_LINES.length + 2]).toMatchObject({
      exportRedaction: expect.stringContaining("nested deeper than"),
    });

    // 原始文本行：口令被替换；截断 JSON 里的 owner 没有被连接串规则吞掉。
    const rawLines = findEntry(entries, `cli/log/${RAW_LOG_FILE}`)
      .split("\n")
      .filter((line) => line.length > 0);
    expect(rawLines).toEqual([
      `[info] connect ${REDACTED_CONNECTION_STRING} failed`,
      `[info] cfg {"url":"${REDACTED_CONNECTION_STRING}","owner":"dev@example.com"`,
      `[info] connect ${REDACTED_CONNECTION_STRING} failed`,
      `[info] GET https://api.example.com/v1/x?token=${REDACTED}&page=2`,
      `{"token":"${REDACTED}","n":1`,
      `[info] header Bearer ${REDACTED} sent`,
    ]);
  });
});
