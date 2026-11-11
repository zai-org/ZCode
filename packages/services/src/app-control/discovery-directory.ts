import { SessionControlError } from "@zcode/session-control/contracts";
import type { IProjectService } from "#src/project/contract.js";
import type {
  IRemoteProjectService,
  RemoteProjectDirectory,
} from "#src/remote-projects/contract.js";
import type {
  AppControlCallerConnection,
  AppControlDiscoveryPort,
  AppControlDiscoverySource,
} from "#src/app-control/contract.js";

export interface AppControlDiscoveryConnection {
  projects: Pick<IProjectService, "readTree">;
  assertCurrent(): void;
}

export function createAppControlDiscoveryDirectory(deps: {
  sourceServerId: string;
  projects: Pick<IProjectService, "readTree">;
  remoteProjects?: Pick<IRemoteProjectService, "readDirectory">;
  resolveSource?: (hostId: string) => Promise<AppControlDiscoveryConnection>;
}): AppControlDiscoveryPort {
  function assertCaller(binding: AppControlCallerConnection): void {
    binding.assertCurrent();
    if (binding.signal.aborted)
      throw new SessionControlError("cancelled", "App discovery call cancelled");
  }
  return {
    async listSources(binding) {
      assertCaller(binding);
      const local: AppControlDiscoverySource = {
        sourceServerId: deps.sourceServerId,
        scopes: [{ kind: "app", scope: "host", sourceServerId: deps.sourceServerId }],
        readTree: () => deps.projects.readTree(),
        assertCurrent: () => assertCaller(binding),
      };
      if (!deps.remoteProjects)
        return {
          sources: [local],
          async prepareValidation() {
            return () => {
              assertCaller(binding);
              return [];
            };
          },
        };
      const retainedSources: Array<{
        sourceServerId: string;
        isRetained(directory: RemoteProjectDirectory): boolean;
      }> = [];
      const directory = await deps.remoteProjects.readDirectory();
      assertCaller(binding);
      const remote = await Promise.all(
        directory.hosts
          .filter((host) => host.id !== deps.sourceServerId)
          .map(async (host) => {
            // 入口 ID 和成员代际必须在 await 前固化；移除后重加不能接纳原连接的迟到结果。
            const hostId = host.id;
            const membershipId = host.membershipId;
            const entries = directory.entries
              .filter((entry) => entry.hostId === hostId && !entry.deleted)
              .map((entry) => ({ id: entry.id, projectId: entry.projectId }));
            if (!entries.length) return undefined;
            const scopes = [
              ...new Set(entries.flatMap((entry) => (entry.projectId ? [entry.projectId] : []))),
            ].map((projectId) => ({
              kind: "app" as const,
              scope: "project" as const,
              sourceServerId: hostId,
              projectId,
            }));
            const unavailable = (reason: string): AppControlDiscoverySource => ({
              sourceServerId: hostId,
              scopes,
              unavailableReason: reason,
              assertCurrent: () => assertCaller(binding),
              async readTree() {
                throw new SessionControlError("unavailable", reason);
              },
            });
            if (host.connectionStatus !== "online") return unavailable("source_offline");
            if (entries.some((entry) => entry.projectId === null))
              return unavailable("legacy_project_unsupported");
            if (!deps.resolveSource) return unavailable("source_unsupported");
            let connection: AppControlDiscoveryConnection;
            try {
              connection = await deps.resolveSource(hostId);
            } catch (error) {
              assertCaller(binding);
              const unsupported =
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "source_unsupported";
              return unavailable(unsupported ? "source_unsupported" : "source_unavailable");
            }
            assertCaller(binding);
            retainedSources.push({
              sourceServerId: hostId,
              isRetained(current) {
                return (
                  current.hosts.some(
                    (item) =>
                      item.id === hostId &&
                      item.membershipId === membershipId &&
                      item.connectionStatus === "online",
                  ) &&
                  entries.every((entry) =>
                    current.entries.some(
                      (item) =>
                        item.id === entry.id &&
                        item.hostId === hostId &&
                        item.projectId === entry.projectId &&
                        !item.deleted,
                    ),
                  )
                );
              },
            });
            return {
              sourceServerId: hostId,
              scopes,
              readTree: () => connection.projects.readTree(),
              assertCurrent() {
                assertCaller(binding);
                connection.assertCurrent();
              },
            } satisfies AppControlDiscoverySource;
          }),
      );
      assertCaller(binding);
      return {
        sources: [
          local,
          ...remote.filter((source): source is AppControlDiscoverySource => !!source),
        ],
        async prepareValidation() {
          assertCaller(binding);
          if (!retainedSources.length)
            return () => {
              assertCaller(binding);
              return [];
            };
          let current: RemoteProjectDirectory;
          try {
            current = await deps.remoteProjects!.readDirectory();
          } catch (error) {
            assertCaller(binding);
            throw error;
          }
          assertCaller(binding);
          // 统一目录快照是本轮入口授权时点，立即固化判定；后续目录变更留给下次查询。
          // 连接仍可能在别的 await 中失效，由消费者在最后一次 await 后同步复验。
          const failures = retainedSources
            .filter((source) => !source.isRetained(current))
            .map((source) => ({
              sourceServerId: source.sourceServerId,
              reason: "source_changed",
            }));
          return () => {
            assertCaller(binding);
            return failures;
          };
        },
      };
    },
  };
}
