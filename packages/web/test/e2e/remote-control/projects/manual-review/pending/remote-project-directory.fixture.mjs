// MRO02：真实 ProjectService / RemoteProjectService / SQLite，网络和模型由用例控制。
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { Emitter } from "../../../../../../../rpc/src/index.ts";
import { TaskIndexRepo } from "../../../../../../../services/src/session/taskIndexRepo.ts";
import {
  createProjectService,
  bindRemoteProjectIdentities,
} from "../../../../../../../services/src/project/index.ts";
import { createRemoteProjectService } from "../../../../../../../services/src/remote-projects/index.ts";
import { createWindowProjectChangesService } from "../../../../../../../services/src/window-project-directory/index.ts";

export async function createProjectDirectoryFixture(artifacts) {
  const root = await mkdtemp(join(artifacts, "data-"));
  const hostId = "remote:server:e2e-directory-source";
  const localPath = join(root, "local");
  const remotePath = join(root, "remote");
  const hiddenPath = join(root, "not-added");
  await Promise.all([localPath, remotePath, hiddenPath].map((path) => mkdir(path)));
  const identity = `${hostId}:${remotePath}`;
  const windowIndex = new TaskIndexRepo(undefined, "local", join(root, "window.sqlite"));
  const sourceIndex = new TaskIndexRepo(undefined, hostId, join(root, "source.sqlite"));
  const windowRepository = await windowIndex.getProjectRepository();
  const sourceRepository = await sourceIndex.getProjectRepository();
  const windowBroadcast = new Emitter();
  const sourceBroadcast = new Emitter();
  const windowChanges = createWindowProjectChangesService({ onMessage: windowBroadcast.event });
  const traffic = { calls: [], opens: [], views: [], errors: [] };
  const changed = () => {
    windowBroadcast.fire({ channel: "state:projects", payload: {} });
  };
  const sourceProject = createProjectService({
    repository: async () => sourceRepository,
    workspaceDirectory: remotePath,
    ownerHostId: hostId,
    afterChange: async () => sourceBroadcast.fire({ channel: "state:projects", payload: {} }),
  });
  const routedSourceProject = bindRemoteProjectIdentities(
    sourceProject,
    async (path) => `${hostId}:${path}`,
  );
  const windowProject = createProjectService({
    repository: async () => windowRepository,
    workspaceDirectory: localPath,
    resolveHost: async (id) => {
      if (id !== hostId) throw new Error("MRO02 unexpected host");
      return routedSourceProject;
    },
    afterChange: async () => changed(),
  });
  const windowRemote = createRemoteProjectService({
    database: () => windowIndex.getOrganizationDatabase(),
    readConnectionStates: async () => new Map([[hostId, { connectionStatus: "online" }]]),
    afterChange: changed,
  });
  const sourceRemote = createRemoteProjectService({
    database: () => sourceIndex.getOrganizationDatabase(),
    controller: false,
  });
  const local = await windowProject.saveProject({ name: "E2E_MRO02_LOCAL", roots: [localPath] });
  const remote = await sourceProject.saveProject({ name: "E2E_MRO02_REMOTE", roots: [remotePath] });
  const hidden = await sourceProject.saveProject({
    name: "E2E_MRO02_NOT_ADDED",
    roots: [hiddenPath],
  });
  await windowRemote.saveHost({
    id: hostId,
    target: { kind: "server", serverId: "e2e-directory-source", url: "https://example.test" },
  });
  await windowRemote.addEntry({
    hostId,
    project: { projectId: remote.id, name: remote.name, roots: remote.roots },
  });
  const tasks = [];
  for (const [index, repository, project, path, taskId, pinned] of [
    [windowIndex, windowRepository, local, localPath, "LOCAL_TASK", false],
    [windowIndex, windowRepository, local, localPath, "PINNED_TASK", true],
    [sourceIndex, sourceRepository, remote, remotePath, "REMOTE_TASK", false],
    [sourceIndex, sourceRepository, hidden, hiddenPath, "NOT_ADDED_TASK", false],
  ]) {
    const task = {
      taskId,
      workspacePath: path,
      ...(project.hostId === hostId ? { workspaceIdentity: `${hostId}:${path}` } : {}),
    };
    repository.reserveCreatedTask({ task, projectId: project.id });
    await index.applyCliFacts({
      meta: {
        ...task,
        traceId: `trace-${taskId}`,
        title: `E2E_MRO02_${taskId}`,
        mode: "default",
        createdAt: 1,
        updatedAt: 2,
      },
      titleSource: "generated",
      lastOutcome: "completed",
    });
    if (pinned) await index.updateTaskState({ ...task, patch: { pinned } });
    tasks.push(repository.readTree().tasks.find((item) => item.taskId === taskId));
  }
  const bind = (owner, channel, service, names) =>
    Object.fromEntries(
      names.map((method) => [
        `${channel}:${method}`,
        async (...args) => {
          traffic.calls.push({ owner, channel, method, args });
          return service[method](...args);
        },
      ]),
    );
  const projectMethods = [
    "readTree",
    "readProjects",
    "saveProject",
    "resolveSessionDirectories",
    "prepareSession",
  ];
  const remoteMethods = ["readDirectory", "refreshEntry", "removeEntry"];
  return {
    root,
    hostId,
    localPath,
    remotePath,
    identity,
    local,
    remote,
    hidden,
    tasks,
    traffic,
    windowProject,
    sourceProject,
    windowRepository,
    workspaces: [
      { workspacePath: localPath, kind: "local", label: "E2E local" },
      {
        workspacePath: remotePath,
        workspaceIdentity: identity,
        remoteSessionId: "mro02-remote-scope",
        kind: "remote",
        label: "E2E remote",
        connectionState: "connected",
      },
    ],
    channels(remoteBridge) {
      return {
        responses: {
          ...bind(
            remoteBridge ? "source" : "window",
            ServiceChannels.Project,
            remoteBridge ? sourceProject : windowProject,
            projectMethods,
          ),
          ...bind(
            remoteBridge ? "source" : "window",
            ServiceChannels.RemoteProjects,
            remoteBridge ? sourceRemote : windowRemote,
            remoteMethods,
          ),
          ...bind("window", "window-project", windowProject, projectMethods),
          ...bind("window", "window-remote-projects", windowRemote, remoteMethods),
          ...bind("window", "window-project-changes", windowChanges, ["getCapabilities"]),
          [`${ServiceChannels.ZCodeTask}:getTaskMeta`]: (input) =>
            tasks.find((task) => task.taskId === input.taskId) ?? null,
        },
        events: {
          [`${ServiceChannels.Broadcast}:onMessage`]: remoteBridge
            ? sourceBroadcast.event
            : windowBroadcast.event,
          "window-project-changes:onDidChange": windowChanges.onDidChange,
        },
      };
    },
    dispose() {
      windowIndex.close();
      sourceIndex.close();
      windowBroadcast.dispose();
      sourceBroadcast.dispose();
    },
  };
}
