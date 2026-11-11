// ZCode Protocol v4 —— 数据模型草稿。
//
// 本包纪律：只放 schema 类型 + 纯函数
// （coalesce/conflation/apply），运行时（通道层缓冲、订阅注册表、调度）一律不进本包。
// 与旧 packages/shared/src/zcode-protocol 并存。
export * from "./core.js";
export * from "../background-bash-output.js";
export * from "./rows.js";
export * from "./toolDisplay.js";
export * from "./create-workflow-display.js";
export * from "./workflow-observation-display.js";
export * from "./snapshot.js";
export * from "./workflow-runs.js";
export * from "./workflow-runs-reducer.js";
export * from "./workflow-runs-holes.js";
// workflowRuns 的键级增量（diff / apply / 规范键序）；op 本身在 delta.js。
export * from "./workflow-runs-delta.js";
// 界留下的痕迹：被拒实例计数、条目预算、步数读法；表满时的腾位；以及给旧消费者的裁剪。
export * from "./workflow-runs-caps.js";
export * from "./workflow-runs-eviction.js";
export * from "./workflow-runs-tables.js";
export * from "./workflow-runs-legacy.js";
export * from "./workflow-artifact.js";
// ⚠ 与上一行只差一个 s，且两个 artifact 不同义：单数 = 引擎内部的「脚本顶层返回值」的
// 序列化；复数 = 脚本 `artifact.*` 发布给用户看的产出。见 workflow-artifacts.ts 的文件头。
export * from "./workflow-artifacts.js";
// 工作区 transcript（files.* / git.* / world.run 的回放）。
export * from "./workflow-workspace.js";
export * from "./attachment-ref.js";
export * from "./attachment-faults.js";
export * from "./delta.js";
export * from "./coalesce.js";
export * from "./profiles.js";
export * from "./apply.js";
export * from "./transport.js";
export * from "./input-prediction/contract.js";
export * from "./session-data/index.js";
export * from "./wire.js";
export * from "./wire-codec.js";
export * from "./wire-reassembly.js";
export * from "./wire-assembler.js";
export * from "./wire-fault.js";
export * from "./sessions-index.js";
export * from "./sessions-index-workflow-activity.js";
export * from "./workspace-config.js";
export * from "./command.js";
export * from "./workflow-run-settings-command.js";
export * from "./shared-context-ref.js";
export * from "./shared-context-import.js";
export * from "./input-intent.js";
export * from "./submission.js";
export * from "./fork.js";
export * from "./telemetry.js";
export * from "./context-composition/contract.js";
export * from "./controller.js";
export * from "./workspace-hook-review.js";
export * from "./cuaPermission.js";

export {
  executionOutputPreviewSchema,
  type ExecutionOutputPreview,
} from "../execution-output-preview.js";

export { bashOutputDisplaySchema } from "../bash-output-display.js";
export { modelSelectionSchema, type ModelSelection } from "../model-selection.js";

export * from "../local-ttft/contract.js";
export * from "./pluginInstall.js";
