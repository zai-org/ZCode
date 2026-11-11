// E2E 扩展 fixture（docs/plugins/extension-host.md §17.4、§18.1 H7，P3c-2）：纯 JS，不需要构建。
// composer.status 的命令每次点击读一次插件目录旁的 e2e-ext-projects-step.json（用例写入），按顺序执行里面的
// 操作：writeAgents 在 ctx.extension.dataPath/workspace 写 AGENTS.md；parallel 把一组 ctx.sessions.* 操作同时发出；
// 其余是 ctx.sessions.* 的单个操作。每个操作的结果或错误码写一行 E2E_PROJECTS_RESULT（只有身份与状态）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function runOp(ctx, op) {
  if (op.name === "writeAgents") {
    const workspace = join(ctx.extension.dataPath, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), `# E2E plugin persona\n\n${op.input.marker}\n`);
    return { workspace };
  }
  return ctx.sessions[op.name](op.input);
}

export async function activate(ctx) {
  const root = join(ctx.extension.path, "..");
  ctx.commands.register("run-step", async () => {
    const step = JSON.parse(await readFile(join(root, "e2e-ext-projects-step.json"), "utf8"));
    for (const [index, op] of step.ops.entries()) {
      const ops = op.name === "parallel" ? op.ops : [op];
      await Promise.all(
        ops.map(async (item, part) => {
          const label = `seq=${step.seq} index=${index}.${part} op=${item.name}`;
          try {
            const result = await runOp(ctx, item);
            ctx.log.info(`E2E_PROJECTS_RESULT ${label} ok=${JSON.stringify(result ?? null)}`);
          } catch (error) {
            ctx.log.info(`E2E_PROJECTS_RESULT ${label} error=${error?.code ?? "unknown"}`);
          }
        }),
      );
    }
    ctx.log.info(`E2E_PROJECTS_DONE seq=${step.seq}`);
  });
  ctx.slots.update("run", { text: "E2E projects", tooltip: "E2E_PROJECTS" });
  ctx.log.info(
    `E2E_PROJECTS_ACTIVATED plugin=${ctx.extension.id} dataPath=${JSON.stringify(ctx.extension.dataPath)}`,
  );
}

export function deactivate() {}
