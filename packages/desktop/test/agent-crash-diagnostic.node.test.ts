// perf_agent_crash 的退出诊断回归。App 业务单测已退役（docs/testing/unit-test-quality.md）；
// 这里是经评审同意的例外：Windows 退出码 0xE0000008 在 Linux 上无法用真实进程复现，
// 只能对纯函数取样。使用 node:test，不进入工程 Vitest 清单和 pre-push；
// 相关文件改动的 MR 上由 CI job test:agent-crash-diagnostic 自动执行（.gitlab/ci/23-agent-crash-diagnostic.yml）。
// pnpm --filter @zcode/desktop test:agent-crash-diagnostic
import assert from "node:assert/strict";
import * as dns from "node:dns";
import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { getSystemErrorMap } from "node:util";
import {
  classifyAgentProcessExitCause,
  parseAgentProcessExitDiagnostic,
  redactAgentDiagnosticSecrets,
} from "@zcode/shared/agent-crash-diagnostic";

// 构造样本：长期运行的 Agent 在几小时前打印过一次 HTTP 429 失败对象，stderr 尾部 20 行
// 只剩响应头逐行转储；值均为虚构。
const STALE_HTTP_429_DUMP = [
  "    connection: 'keep-alive',",
  "    'content-type': 'application/json',",
  "    date: 'Mon, 02 Nov 2026 01:02:03 GMT',",
  "    eagleid: '0123456789abcdef0123456789',",
  "    server: 'ESA',",
  "    'set-cookie': ***REDACTED***,",
  "    'strict-transport-security': 'max-age=31536000; includeSubDomains',",
  "    'transfer-encoding': 'chunked',",
  "    vary: 'Origin, Access-Control-Request-Method',",
  "    via: 'cache-1.example[100,0,DP], cache-2.example[101,0]',",
  "    'x-content-type-options': 'nosniff',",
  "    'x-request-id': '20261102010203abcdef',",
  "    'x-site-cache-status': 'DYNAMIC'",
  "  },",
  "  responseStatus: 429,",
  "  statusCode: undefined,",
  "  code: undefined",
  "}",
];

const NATIVE_OOM_EXIT_CODE = 3758096392; // 0xE0000008

test("classifies the Windows native allocation failure exit code as out of memory", () => {
  assert.equal(classifyAgentProcessExitCause(NATIVE_OOM_EXIT_CODE), "native_out_of_memory");
  // 有符号 int32 形式的同一个 DWORD。
  assert.equal(classifyAgentProcessExitCause(-536870904), "native_out_of_memory");
  for (const exitCode of [null, undefined, 0, 1, 137, 0xc0000005, 0x40010004]) {
    assert.equal(classifyAgentProcessExitCause(exitCode), undefined, String(exitCode));
  }
});

test("reports exit 0xE0000008 as AgentOutOfMemory even when stderr ends with a stale HTTP 429 dump", () => {
  const diagnostic = parseAgentProcessExitDiagnostic({
    exitCode: NATIVE_OOM_EXIT_CODE,
    signal: null,
    stderrTail: STALE_HTTP_429_DUMP,
    workspacePath: "/Users/dev/project",
  });

  assert.equal(diagnostic.errorName, "AgentOutOfMemory");
  assert.equal(diagnostic.errorCode, "ERR_OUT_OF_MEMORY");
  assert.equal(diagnostic.diagnosticClass, "oom");
  assert.equal(diagnostic.errorMessage, "Native memory allocation failed (exit code 0xE0000008)");
  // stderr 仍随事件保留，便于排查，但不进入指纹：有无历史输出都聚合到同一类。
  assert.match(diagnostic.errorStack, /responseStatus: 429/);
  const withoutStderr = parseAgentProcessExitDiagnostic({
    exitCode: NATIVE_OOM_EXIT_CODE,
    signal: null,
    workspacePath: "/Users/dev/other",
  });
  assert.equal(diagnostic.errorFingerprint, withoutStderr.errorFingerprint);
});

test("does not take error code or summary from an HTTP response header dump", () => {
  const exit1 = parseAgentProcessExitDiagnostic({
    exitCode: 1,
    signal: null,
    stderrTail: STALE_HTTP_429_DUMP,
    workspacePath: "/Users/dev/project",
  });

  assert.equal(exit1.errorCode, "");
  assert.equal(exit1.errorName, "AgentProcessExit");
  assert.equal(exit1.diagnosticClass, "none");
  assert.equal(exit1.errorMessage, "Agent process exited unexpectedly (code=1, signal=null)");

  const exit2 = parseAgentProcessExitDiagnostic({
    exitCode: 2,
    signal: null,
    stderrTail: STALE_HTTP_429_DUMP,
    workspacePath: "/Users/dev/project",
  });
  // 指纹随退出码区分，而不是被同一段无关日志聚到一起。
  assert.notEqual(exit1.errorFingerprint, exit2.errorFingerprint);
});

test("only accepts real errno names when no explicit code is printed", () => {
  const diagnostic = parseAgentProcessExitDiagnostic({
    exitCode: 1,
    signal: null,
    stderrTail: ["Unexpected END of input while reading ENV file"],
    workspacePath: "/Users/dev/project",
  });
  assert.equal(diagnostic.errorCode, "");
  assert.equal(diagnostic.diagnosticClass, "generic");
});

test("keeps errno and V8 heap out-of-memory diagnostics from stderr", () => {
  const errno = parseAgentProcessExitDiagnostic({
    exitCode: 1,
    signal: null,
    stderrTail: [
      "node:events:497",
      "      throw er; // Unhandled 'error' event",
      "Error: write EPIPE",
      "    at afterWriteDispatched (node:internal/stream_base_commons:161:15)",
      "  errno: -32,",
      "  code: 'EPIPE',",
      "  syscall: 'write'",
      "}",
    ],
    workspacePath: "/Users/dev/project",
  });
  assert.equal(errno.errorName, "Error");
  assert.equal(errno.errorCode, "EPIPE");
  assert.equal(errno.diagnosticClass, "errno");
  assert.equal(errno.errorMessage, "write EPIPE");

  const heap = parseAgentProcessExitDiagnostic({
    exitCode: 134,
    signal: null,
    stderrTail: [
      "<--- Last few GCs --->",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    ],
    workspacePath: "/Users/dev/project",
  });
  assert.equal(heap.errorName, "AgentOutOfMemory");
  assert.equal(heap.errorCode, "ERR_OUT_OF_MEMORY");
  assert.equal(heap.diagnosticClass, "oom");
});

test("recognizes every errno and DNS error name Node reports, e.g. getaddrinfo ENOTFOUND", () => {
  // 名单手写，会漏：以运行时 Node 自己的 errno / dns 错误码为准逐个核对。
  // EOF、UNKNOWN 故意不收：普通文本里太常见，会重演 `ESA` 那类误报。
  const names = new Set([
    ...[...getSystemErrorMap().values()].map(([name]) => name),
    ...Object.keys(osConstants.errno),
    ...Object.values(dns).filter(
      (value): value is string => typeof value === "string" && /^E[A-Z]+$/.test(value),
    ),
  ]);
  names.delete("EOF");
  names.delete("UNKNOWN");
  // Windows 的 os.constants.errno 还含 `WSAEINTR` 这类 Winsock 常量；Node 报错用的是 libuv 的
  // 通用名（ECONNRESET 等），解析器也只认 E 开头的名字。只核对 E 开头的，避免在 Windows 上误报。
  for (const name of names) if (!/^E[A-Z0-9_]+$/.test(name)) names.delete(name);
  for (const code of names) {
    const diagnostic = parseAgentProcessExitDiagnostic({
      exitCode: 1,
      signal: null,
      stderrTail: [`Error: getaddrinfo ${code} api.example.com`],
      workspacePath: "/Users/dev/project",
    });
    assert.equal(diagnostic.errorCode, code, code);
    assert.equal(diagnostic.diagnosticClass, "errno", code);
  }
});

test("does not report Bearer tokens or later cookie segments", () => {
  const diagnostic = parseAgentProcessExitDiagnostic({
    exitCode: 1,
    signal: null,
    stderrTail: [
      "Error: request failed",
      "  Authorization: Bearer fake-bearer-value-0001",
      "  cookie: session=fake-cookie-a; refresh=fake-cookie-b",
    ],
    workspacePath: "/Users/dev/project",
  });
  for (const secret of ["fake-bearer-value-0001", "fake-cookie-a", "fake-cookie-b"]) {
    assert.doesNotMatch(diagnostic.errorStack, new RegExp(secret), secret);
    assert.doesNotMatch(diagnostic.errorMessage, new RegExp(secret), secret);
  }
});

// 真实链路：services 逐行收集 stderr 时先遮一遍，desktop main 上报前再遮一遍。
const SERVICES_SOURCE = resolve(
  import.meta.dirname,
  "../../services/src/zcode-agent/zcodeAgentProcessManager.ts",
);

function parseThroughServicesAndMain(stderrTail: string[]) {
  return parseAgentProcessExitDiagnostic({
    exitCode: 1,
    signal: null,
    stderrTail: stderrTail.map(redactAgentDiagnosticSecrets),
    workspacePath: "/Users/dev/project",
  });
}

test("services stderr redaction delegates to the shared rules instead of keeping its own", () => {
  // 两层各维护一套时，services 先做赋值替换会破坏 main 的 Bearer 锚点，token 随 errorStack 上报。
  const source = readFileSync(SERVICES_SOURCE, "utf8");
  assert.match(source, /return redactAgentDiagnosticSecrets\(value\);/);
  assert.doesNotMatch(source, /Bearer\|Basic/);
});

test("does not report credentials after the services layer has already redacted each line", () => {
  const diagnostic = parseThroughServicesAndMain([
    "Error: request failed",
    "  Authorization: Bearer fake-bearer-value-0002",
    "  Proxy-Authorization: Basic fake-basic-value-0003",
    "  cookie: session=fake-cookie-d; refresh=fake-cookie-e",
  ]);
  for (const secret of [
    "fake-bearer-value-0002",
    "fake-basic-value-0003",
    "fake-cookie-d",
    "fake-cookie-e",
  ]) {
    assert.doesNotMatch(diagnostic.errorStack, new RegExp(secret), secret);
    assert.doesNotMatch(diagnostic.errorMessage, new RegExp(secret), secret);
  }
});

test("redacting already-redacted text again changes nothing", () => {
  for (const line of [
    "  Authorization: Bearer fake-bearer-value-0004",
    "  cookie: a=fake-cookie-f; b=fake-cookie-g",
    '{"headers":{"cookie":"sid=fake-cookie-h"},"code":"ECONNRESET"}',
    "  'set-cookie': [ 'sid=fake-cookie-i; Path=/' ],",
    "password=fake-password-0005 token: 'fake-token-0006'",
  ]) {
    const once = redactAgentDiagnosticSecrets(line);
    assert.equal(redactAgentDiagnosticSecrets(once), once, line);
  }
});

test("keeps the error code that follows a quoted cookie on the same line", () => {
  const diagnostic = parseThroughServicesAndMain([
    '{"headers":{"cookie":"sid=fake-cookie-j; uid=fake-cookie-k"},"code":"ECONNRESET"}',
  ]);
  assert.doesNotMatch(diagnostic.errorStack, /fake-cookie-j|fake-cookie-k/);
  assert.equal(diagnostic.errorCode, "ECONNRESET");
  assert.equal(diagnostic.diagnosticClass, "errno");
});
