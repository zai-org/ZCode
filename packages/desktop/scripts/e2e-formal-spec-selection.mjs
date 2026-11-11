// 直接读取内部队列会让开源 WDIO 配置加载失败；清单由原队列生成，目标判定保持一致。
import remoteTargetSpecs from "./e2e-remote-target-specs.json" with { type: "json" };

export const SSH_FORMAL_SPEC_GLOB =
  "./test/e2e/conversation-session/**/conversation-session-ssh-remote*.test.ts";
// Bug 根因：逐领域枚举漏掉新增候选目录，导致单进程全量与分片正式集合不一致。
export const MANUAL_REVIEW_SPEC_GLOB = "./test/e2e/**/manual-review/**/*.test.ts";

const REQUIRED_SSH_E2E_ENV = [
  "ZCODE_E2E_SSH_HOST",
  "ZCODE_E2E_SSH_USERNAME",
  "ZCODE_E2E_SSH_PASSWORD",
];

export function hasRequiredSshE2EEnvironment(env) {
  return REQUIRED_SSH_E2E_ENV.every((name) => env[name]?.trim());
}

// 修复原因：远程队列 case 由 harness 按 case 准备干净目标（ZCODE_E2E_SSH_CONTAINER 是其标记）。
// Windows CI 只有共享 SSH 凭据时仍纳入它们，多个分片在同一主机上互相升级/抢占，
// 表现为"更新中"、source-server-upgrade-required 与缺少容器。没有 harness 时整体排除。
function hasSshHarnessE2EEnvironment(env) {
  return hasRequiredSshE2EEnvironment(env) && Boolean(env.ZCODE_E2E_SSH_CONTAINER?.trim());
}

function isRemoteQueueFormalSpec(spec) {
  const normalized = spec.replaceAll("\\", "/");
  return remoteTargetSpecs.some((candidate) => normalized.endsWith(`/test/e2e/${candidate}`));
}

export function isSshFormalSpec(spec) {
  const normalized = spec.replaceAll("\\", "/");
  return (
    /\/conversation-session\/(?:[^/]+\/)*conversation-session-ssh-remote/u.test(normalized) ||
    isRemoteQueueFormalSpec(normalized)
  );
}

/** 默认正式集合的环境准入：队列 case 要 harness，尚未入队的 ssh-remote 只要凭据。 */
export function isFormalSpecAdmittedByEnvironment(spec, env) {
  // 场景 glob 会递归命中候选；分片展开为显式文件前必须排除，不能把目录迁移当作转正。
  if (spec.replaceAll("\\", "/").includes("/manual-review/")) return false;
  if (isRemoteQueueFormalSpec(spec)) return hasSshHarnessE2EEnvironment(env);
  if (isSshFormalSpec(spec)) return hasRequiredSshE2EEnvironment(env);
  return true;
}

export function resolveEnvironmentGatedFormalSpecExcludes({ env, targeted }) {
  // 修复原因：SSH P0 依赖真实服务器，默认全量在无凭据时纳入只会把环境缺失
  // 误记为三个产品失败；显式定向运行仍保留 helper 的缺变量 fail-closed 提示。
  if (targeted) return [];
  return [
    ...(hasRequiredSshE2EEnvironment(env) ? [] : [SSH_FORMAL_SPEC_GLOB]),
    ...(hasSshHarnessE2EEnvironment(env)
      ? []
      : remoteTargetSpecs.map((spec) => `./test/e2e/${spec}`)),
  ];
}

/** 目录 glob 是批量回归；只有逐个指定文件才覆盖环境门禁并按缺配置报错。 */
export function isExplicitE2ESpecSelection(specs) {
  return specs.length > 0 && specs.every((spec) => !/[*?[{]/u.test(spec));
}
