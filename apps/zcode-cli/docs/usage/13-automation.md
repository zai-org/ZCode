# 13 · 批量任务与运行记录

CLI 可以作为任务执行器；数据准备、环境隔离、资源预算和评分由外部启动器负责。现成 benchmark 的容器、超时、补丁提取和评分协议仍须单独适配，不能把一次 prompt 成功当作 benchmark 集成完成。

## 每个样本固定哪些条件

保存构建提交或二进制 SHA-256、CLI 版本与 doctor 输出、平台、模型与 provider 协议、非敏感模型选项、任务输入、工作区提交、扩展清单、工具过滤、权限模式和运行时限。API Key 与登录凭据不要归档。

每个独立样本使用独立的工作目录、用户目录和数据基目录。只换 sessionId 或只设置 `ZCODE_STORAGE_DIR` 不足以隔离个人配置、插件、记忆和用户指令。允许跨轮复用的实验应显式记录复用关系。

## 跨平台启动方式

以下 Node.js 片段展示参数数组与子进程环境。由调用方传入真实路径和任务文本；不要把模型输出拼接为 shell 命令。示例假定模型配置和运行配置已写入 `runHome` 对应目录，具体格式见[配置](03-config.md)。

```js
import { spawn } from "node:child_process";

// 这些值由任务启动器提供，不从模型输出中执行。
const executable = process.argv[2]; // SEA 的绝对路径；Node bundle 则使用 Node 路径
const workdir = process.argv[3];
const runHome = process.argv[4];
const prompt = process.argv[5];
if (![executable, workdir, runHome, prompt].every(Boolean)) {
  throw new Error("需要 executable、workdir、runHome、prompt");
}

// 实际任务中从受控的环境变量白名单构造，不继承个人凭据。
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir)$/i.test(key)) {
    env[key] = value;
  }
}
Object.assign(env, { HOME: runHome, USERPROFILE: runHome, ZCODE_DATA_BASE_DIR: runHome });

const args = [
  // 使用 Node bundle 时，在这里先加入 zcode.cjs 的绝对路径。
  "--prompt",
  prompt,
  "--cwd",
  workdir,
  "--mode",
  "yolo",
  "--disallowed-tools",
  "AskUserQuestion EnterPlanMode ExitPlanMode",
  "--output-format",
  "stream-json",
  "--no-color",
];
const child = spawn(executable, args, { cwd: workdir, env, shell: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.stderr.write(`${JSON.stringify({ code, signal })}\n`);
  process.exitCode = code ?? 1;
});
```

这只是启动片段。生产启动器还要持续写入 stdout/stderr 文件、记录开始结束时间、限制磁盘用量，并由容器或进程管理器设置运行时限、终止整个进程树。不能只杀父进程后假设所有 Bash、MCP 和后台任务都结束。按目标系统验证进程树清理。

`-p` 运行在后台工作结束前不退出，不论 `--agent-always-background` 取值：第一个回合结束后，进程一直等到没有运行中的后台任务（Agent、Bash、workflow），也没有正在运行或排队的回合，才写出结果并退出。完成通知触发的回合也在等待之内，所以进程退出时任务产物已经写完，评分可以开始。等待不设超时：模型在后台启动的常驻进程（例如开发服务器）会让运行一直等待，运行时限由启动器设置。`--target` 和以 `/goal`、`/expert` 开头的 `-p` 走命令路径，命令返回后同样等待；目标续跑遇到后台任务时先推迟，通知回合在 runtime 内接着续跑，这些都在等待之内。这类运行输出命令本身的 `response`，不收集之后各回合的文字。等待期间收到 Ctrl-C 或启动器的信号时，进程不写结果：stdout 为空，错误写到 stderr，退出码是信号对应的值，所以启动器只看 stdout 就能分辨中断和正常结束。规则见 [dwf launch 的 Headless runs](../../../../docs/dynamic-workflow/launch.md#headless-runs)。

## 如何判定一次运行

```text
启动失败 / 被取消 / 超时 → 保存失败证据，不判成功
正常结束 → 解析输出 → 检查工具错误与任务产物 → 独立评分
独立评分完成 → 生成样本状态与分数
```

保留 `sessionId`、`traceId`、`turnId`、原始退出码、signal 和超时状态。JSON 的 response 是最终回答；stream-json 包含事件和最终 result。二者都不等价于完整 provider 请求/响应，更不自动等价于可训练对话。

恢复任务应显式使用 `--resume`，并保持同一隔离数据目录；不要让并发样本争用 `--continue` 的“最近会话”。

## 训练轨迹与 model-io

默认 model-io 日志用于诊断，可能使用 full/delta/tail 表达、字段裁剪和按文件大小保留。standalone CLI 不应被假定启用了 App 的完整 model-io 保留选项。生产默认有限保留通常为每个文件 64 MiB、保留最近 3 个会话文件；开发默认上限不同。采集开始前核对当前构建的[保留策略](../../../../docs/model-io-full-retention-setting.md)。

源码仓库提供独立的测试辅助工具，未打包进生产 SEA。对兼容格式的已有日志，转换命令为：

```sh
pnpm --filter @zcode/prompt-trajectory model-io -- --input /absolute/path/to/model-io-session.jsonl --out /absolute/path/to/derived
```

转换器默认关注主轮次，展开可恢复的增量并按连续片段处理；它无法补回已裁剪、覆盖或缺失的请求。非增量请求也不能直接解释为 provider 缓存未命中。输出格式及记录工具说明见[轨迹工具](../../tools/prompt-trajectory/README.md)。

本次对当前源码生成的默认日志执行上述命令，得到 `model-io request.body must contain a messages array.`：记录中的 `request.body.messages` 已被裁掉，转换器要求该字段。此路径未通过实际转换验收，不能直接用作训练数据流水线。保留原始日志和错误；不要把内部 `request.messages` 强行填回 provider 请求体来伪造完整记录。默认日志在本次运行中位于隔离数据目录的 `.zcode/cli/rollout/`。

同一辅助包的 `record:prompt` 已在 2026-10-21 修复，并用本地模拟上游验证可以录制。每次录制使用临时 home 与 `ZCODE_STORAGE_DIR`，不读取用户的 skill、插件和会话库；用真实模型录制前，仍需按[轨迹工具](../../tools/prompt-trajectory/README.md)提供 `--model` 与 `--upstream-base-url`。

需要训练数据时，明确采集层、协议、消息顺序、tool call 与 tool result 对应关系、失败样本策略以及隐私处理。使用受控 provider 记录完整请求/响应，并验证与 CLI 工具事件一致；不要只收集最终答案或让模型转述轨迹。

采集时将[个人模型配置](03-config.md)中的 `api.baseUrl` 指向自己管理的、兼容所选协议的记录服务，再使用普通 CLI 执行任务。记录服务负责转发和保存真实请求/响应；保留流式分片顺序，按 tool call ID 关联调用与结果，并排除鉴权 header。先用一个可检查的工具任务验证记录完整，再运行批量任务。这条流程不依赖上述仓库辅助包。

## 验证范围

本指南在 2026-10-14 对照当前源码核对。已在 macOS arm64 构建 CLI，并用本地模拟 Chat Completions 服务验证个人 provider 配置、普通 JSON、stream-json、显式会话恢复、Bash 执行、plan 拒绝及同步 Hook 拒绝。还验证了本地插件结构、技能与命令发现、项目 Hook 信任的 review/grant/revoke。模拟服务验证接线与格式，不代表真实模型效果。默认 model-io 日志转换未通过，原因见上文；辅助包 record:prompt 于 2026-10-21 修复后用本地模拟上游验证。

本次验证在源码工作区执行，未另行构建完整开源导出树。Windows、Linux、全部 SEA 目标、真实 provider、MCP 远程授权和完整 benchmark 评分未在本次文档更新中逐项验收。使用前按目标环境执行最小任务；不要将本指南理解为所有平台与扩展均已实测的声明。
