#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";

function printUsageAndExit() {
  process.stderr.write(
    [
      "Usage: zcode-stdio-tap.mjs --workspace-key <key> [--log-dir <dir>] -- <command> [...args]",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex < 0) {
    printUsageAndExit();
  }

  const options = argv.slice(0, separatorIndex);
  const commandAndArgs = argv.slice(separatorIndex + 1);
  if (commandAndArgs.length === 0) {
    printUsageAndExit();
  }

  let workspaceKey = "";
  let logDir = process.env.ZCODE_STDIO_TAP_LOG_DIR?.trim() || "";

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--workspace-key") {
      workspaceKey = options[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (option === "--log-dir") {
      logDir = options[index + 1] ?? "";
      index += 1;
      continue;
    }
    printUsageAndExit();
  }

  if (!workspaceKey.trim()) {
    printUsageAndExit();
  }

  return {
    command: commandAndArgs[0],
    args: commandAndArgs.slice(1),
    logDir: logDir || join(homedir(), ".zcode", "v2", "dev", "stdio-traffic"),
    workspaceKey,
  };
}

function workspaceHash(workspaceKey) {
  return createHash("sha256").update(workspaceKey).digest("hex").slice(0, 12);
}

function tryParseJsonLine(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { message: null, parseError: null };
  }

  try {
    return { message: JSON.parse(trimmed), parseError: null };
  } catch (error) {
    return {
      message: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractProtocolMeta(message) {
  if (!message || typeof message !== "object") {
    return {};
  }

  const params = "params" in message && typeof message.params === "object" ? message.params : null;
  const payload =
    params && "payload" in params && typeof params.payload === "object" ? params.payload : null;

  return {
    id: "id" in message ? message.id : undefined,
    method: "method" in message ? message.method : undefined,
    sessionId:
      params && "sessionId" in params
        ? params.sessionId
        : payload && "sessionId" in payload
          ? payload.sessionId
          : undefined,
    inputId:
      params && "inputId" in params
        ? params.inputId
        : payload && "inputId" in payload
          ? payload.inputId
          : undefined,
  };
}

function createRecorder({ childPid, stream, workspaceKey }) {
  const credentialReplies = new Set();
  return function recordLine(direction, raw, bytes) {
    const parsed =
      direction === "agent-stderr" ? { message: null, parseError: null } : tryParseJsonLine(raw);
    const meta = extractProtocolMeta(parsed.message);
    const message = parsed.message;
    const replyKey = `${direction}:${typeof meta.id}:${meta.id}`;
    if (meta.method === "interaction/requestCredentialCipher") {
      const replyDirection = direction === "agent-to-app" ? "app-to-agent" : "agent-to-app";
      credentialReplies.add(`${replyDirection}:${typeof meta.id}:${meta.id}`);
      // 加解密载荷含凭据明文；调试抓包只保留元数据，转发的原始字节不变。
      parsed.message = {
        jsonrpc: message.jsonrpc,
        id: meta.id,
        method: meta.method,
        params: "<redacted>",
      };
      raw = JSON.stringify(parsed.message);
    } else if (!meta.method && credentialReplies.delete(replyKey)) {
      parsed.message = { jsonrpc: message.jsonrpc, id: meta.id, result: "<redacted>" };
      raw = JSON.stringify(parsed.message);
    }
    const record = {
      ts: new Date().toISOString(),
      workspaceKey,
      proxyPid: process.pid,
      pid: childPid,
      direction,
      bytes,
      raw,
      message: parsed.message,
      parseError: parsed.parseError,
      ...meta,
    };
    stream.write(`${JSON.stringify(record)}\n`);
  };
}

function createLineTap(direction, recordLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  return {
    push(chunk) {
      pending += decoder.write(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        recordLine(
          direction,
          line.endsWith("\r") ? line.slice(0, -1) : line,
          Buffer.byteLength(line),
        );
      }
    },
    flush() {
      const tail = `${pending}${decoder.end()}`;
      pending = "";
      if (tail.length > 0) {
        recordLine(
          direction,
          tail.endsWith("\r") ? tail.slice(0, -1) : tail,
          Buffer.byteLength(tail),
        );
      }
    },
  };
}

const config = parseArgs(process.argv.slice(2));
const dir = join(config.logDir, workspaceHash(config.workspaceKey));
mkdirSync(dir, { recursive: true });

const child = spawn(config.command, config.args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const logFilePath = join(
  dir,
  `${new Date().toISOString().replace(/[:.]/g, "-")}-proxy-${process.pid}-agent-${child.pid ?? "unknown"}.ndjson`,
);
writeFileSync(join(dir, "latest.txt"), `${logFilePath}\n`);

const stream = createWriteStream(logFilePath, { flags: "a" });
const recordLine = createRecorder({
  childPid: child.pid ?? null,
  stream,
  workspaceKey: config.workspaceKey,
});

const stdinTap = createLineTap("app-to-agent", recordLine);
const stdoutTap = createLineTap("agent-to-app", recordLine);
const stderrTap = createLineTap("agent-stderr", recordLine);

child.on("error", (error) => {
  recordLine(
    "agent-stderr",
    `[tap] spawn failed: ${error.message}`,
    Buffer.byteLength(error.message),
  );
  process.stderr.write(`[zcode-stdio-tap] spawn failed: ${error.message}\n`);
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  stdoutTap.push(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  stderrTap.push(chunk);
});

process.stdin.on("data", (chunk) => {
  stdinTap.push(chunk);
  if (!child.stdin.write(chunk)) {
    process.stdin.pause();
  }
});

child.stdin.on("drain", () => {
  process.stdin.resume();
});

process.stdin.on("end", () => {
  stdinTap.flush();
  child.stdin.end();
});

function forwardSignal(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("close", (code, signal) => {
  stdinTap.flush();
  stdoutTap.flush();
  stderrTap.flush();
  stream.end(() => {
    process.exit(code ?? (signal ? 1 : 0));
  });
});
