import { parseArgs } from "node:util";

const groups = {
  "session-ready-only": ["session-ready"],
  "background-only": ["background"],
  "photocraft-background-only": ["background"],
  "showcase-only": ["showcase"],
  "sampling-only": ["sampling"],
  "rows-only": ["rows"],
  "managed-only": ["interaction", "managed", "managed-empty"],
  "chain-only": ["chain"],
  "retention-only": ["retention"],
  "storage-only": ["write", "read", "empty"],
};

export function parseMcpAppsHostOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      ...Object.fromEntries(Object.keys(groups).map((key) => [key, { type: "boolean" }])),
      "reuse-agent-build": { type: "boolean" },
      "output-dir": { type: "string" },
    },
  });
  const selected = Object.keys(groups).filter((key) => values[key]);
  // 正式入口不能因拼错参数或混用模式而静默运行其它场景。
  if (selected.length > 1) throw new Error("Select only one MCP App E2E group");
  if (values["output-dir"] !== undefined && !values["output-dir"].trim())
    throw new Error("output-dir must not be empty");
  return {
    modes: selected.length
      ? groups[selected[0]]
      : [
          "write",
          "read",
          "empty",
          "chain",
          "interaction",
          "managed",
          "managed-empty",
          "retention",
          "rows",
          "sampling",
          "background",
        ],
    outputDir: values["output-dir"],
    reuseAgentBuild: values["reuse-agent-build"] === true,
  };
}

export function resolveMcpAppsHostLaunch(electron, args, env) {
  // Linux replay 容器以 root 运行；仅测试容器使用这些参数，不改变本机启动方式。
  if (env.ZCODE_E2E_CONTAINER !== "1") return { command: electron, args };
  // Electron 会保留 Chromium 参数；放在末尾，避免挤占夹具按位置读取的 root/profile。
  const containerArgs = [...args, "--no-sandbox", "--disable-dev-shm-usage"];
  return env.DISPLAY
    ? { command: electron, args: containerArgs }
    : { command: "xvfb-run", args: ["--auto-servernum", electron, ...containerArgs] };
}
