// R3 远程 e2e 服务器全量队列（harness/remote/run-all-remote.sh）的共享名单与解析：
// 专用 fixture 例外供 run-queue.mjs 报告阻塞，队列目标类型供正式回归筛选需要 SSH 的 spec。

/**
 * 属于远程 spec、但全量队列现有档位无法构造其 fixture 的例外（相对 test/e2e）。
 * run-queue.mjs 把这些 spec 报告为阻塞并保留在计划分母中，不要求排进 run-all-remote.sh；
 * 每一条必须写明队列缺什么，补齐 harness 后即从这里移除并入队。
 */
// 根因：队列早已为每条 case 新建干净用户，旧例外却仍追加同名结果，覆盖了真正的安装进度结果。
// 三屏向导由队列指定 home 为首目录，不再依赖人工 fixture。
export const DEDICATED_FIXTURE_SPECS = [
  // 队列缺 E-SVC 目标：需要以 systemd 为 PID 1 的 privileged 容器和常驻 user manager。
  // 本机运行：R3_DAEMON_SERVICE_CASE=<子场景> node harness/remote/run-local-docker.mjs --systemd <spec>。
  "conversation-session/remote/installation/manual-review/pending/conversation-session-r3-daemon-service-fallback.test.ts",
  // 同样需要 E-SVC 目标：daemon 以 OS 用户服务运行时删除并重装 server root（A4）。
  // 本机运行：node harness/remote/run-local-docker.mjs --systemd <spec>。
  "conversation-session/remote/installation/manual-review/pending/conversation-session-remote-server-root-replaced-ssh.test.ts",
  // 同样需要 E-SVC 目标：同容器内以独立 PID 命名空间的第二个 user service 模拟共享 home 的另一台主机。
  // 本机运行：node harness/remote/run-local-docker.mjs --systemd <spec>。
  "conversation-session/remote/execution/manual-review/pending/conversation-session-remote-shared-root-peer-host-ssh.test.ts",
];

/**
 * 从服务器队列脚本文本里提取被排进队列的 spec。队列使用 `$PENDING/<name>`、`$FORMAL/<name>`
 * 与完整 `test/e2e/...` 三种写法，这里都归一成相对 test/e2e 的路径。
 */
function extractQueuedSpecs(queueSource) {
  const queued = new Set();
  for (const match of queueSource.matchAll(/\$PENDING\/([\w.-]+\.test\.ts)/gu)) {
    queued.add(`conversation-session/manual-review/pending/${match[1]}`);
  }
  for (const match of queueSource.matchAll(/\$FORMAL\/([\w.-]+\.test\.ts)/gu)) {
    queued.add(`conversation-session/${match[1]}`);
  }
  for (const match of queueSource.matchAll(/test\/e2e\/([\w./-]+\.test\.ts)/gu)) {
    queued.add(match[1]);
  }
  return [...queued].sort();
}

/** 默认正式回归的环境门禁复用队列的目标类型；none 档位不需要 SSH。 */
export function extractRemoteTargetSpecs(queueSource) {
  return [
    ...new Set(
      queueSource
        .split("\n")
        .filter((line) => /^\s*run_(?:case|git_case|dual_case|docker_case|env_case)\s/u.test(line))
        .flatMap((line) => extractQueuedSpecs(line))
        .map((spec) => spec.replace("/manual-review/pending/", "/")),
    ),
  ].sort();
}
