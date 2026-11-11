import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, type DynamicWorkflowMode } from "@zcode/shared";

/**
 * 动态工作流灰度（docs/dynamic-workflow/launch.md「Gray release: the `dynamicWorkflow` feature key」）
 * 的 case-local 配置网关。Host 从 `/api/v1/client/configs` 读 `data.configs.dynamicWorkflow.mode`，
 * 这里按 spec 文件名挑一个档位并改写共享 fixture 的这一个键，其余键原样下发。
 *
 * 只 mock 服务端 key，不使用 ZCODE_DYNAMIC_WORKFLOW_MODE 本地覆盖：DWG-08 要验证的正是
 * 「服务端说了算」这条链路，覆盖会把它短路掉。
 */
const DISABLED_SPEC_FRAGMENT = "conversation-session-dynamic-workflow-gray-disabled";
const ALWAYS_ON_SPEC_FRAGMENT = "conversation-session-dynamic-workflow-gray-always-on";
const ON_DEMAND_SPEC_FRAGMENT = "conversation-session-dynamic-workflow-gray-on-demand";

export type DynamicWorkflowConfigMockScenario = DynamicWorkflowMode;

export interface DynamicWorkflowConfigMockServer {
  baseUrl: string;
  scenario: DynamicWorkflowConfigMockScenario;
  stop(): Promise<void>;
}

/** 灰度 spec 从 mock 网关读的观测端点，用来证明 Host 真的问过这台服务器。 */
export const DYNAMIC_WORKFLOW_CONFIG_MOCK_STATUS_PATH = "/__dwg/status";

export interface DynamicWorkflowConfigMockStatus {
  scenario: DynamicWorkflowConfigMockScenario;
  /** 本档位实际下发的 mode；`disabled` 档位不下发该 key，所以是 null。 */
  mode: DynamicWorkflowMode | null;
  configRequests: number;
}

export function resolveDynamicWorkflowConfigMockScenario(
  specs: readonly string[],
): DynamicWorkflowConfigMockScenario | null {
  const disabled = specs.some((spec) => spec.includes(DISABLED_SPEC_FRAGMENT));
  // Bug 原因：中枢用例依赖开启状态，未声明配置前置时会命中真实灰度的 disabled。
  // 与灰度正向用例共用服务端 fixture，不用本地 override 绕过 Host 裁决。
  const alwaysOn = specs.some(
    (spec) =>
      spec.includes(ALWAYS_ON_SPEC_FRAGMENT) ||
      spec.endsWith("conversation-session-dynamic-workflow-holes.test.ts") ||
      // PLUS05 明确以 catalog 含 workflow 为前置，不能依赖线上灰度值。
      spec.endsWith("conversation-session-plus-menu.test.ts") ||
      spec.replaceAll("\\", "/").split("/").at(-1) === "automations-workflows-hub.test.ts",
  );
  const onDemand = specs.some((spec) => spec.includes(ON_DEMAND_SPEC_FRAGMENT));
  if ([disabled, alwaysOn, onDemand].filter(Boolean).length > 1) {
    // 几个档位靠同一个 endpoint origin 区分，同一个 worker 里无法并存；
    // 与其静默选一个让断言变成假阳性，不如在 beforeSession 就失败。
    throw new Error(
      "Dynamic workflow gray E2E: disabled、alwaysOn 与 onDemand spec 必须分属不同 worker，不能共享一个 mock 网关",
    );
  }
  if (disabled) return "disabled";
  if (onDemand) return "onDemand";
  if (alwaysOn) return "alwaysOn";
  return null;
}

export function applyDynamicWorkflowConfigMockEnv(
  environment: Record<string, string | undefined>,
  baseUrl: string,
): void {
  environment.ZCODE_BASE_URL = baseUrl;
  environment.ZCODE_TEST_BASE_URL = baseUrl;
  environment.ZCODE_ENDPOINT_ORIGIN = baseUrl;
  // 未打包 dev 档位下 Main 会把开发者 shell 里的合法 ZCODE_DYNAMIC_WORKFLOW_MODE 透传给 Host
  // （docs/dynamic-workflow/launch.md「The local override」），那会盖掉本用例的服务端判定。
  // worker 进程一轮只跑一个 spec 文件，这里直接删掉即可，不需要回填。
  delete environment[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV];
}

export function clearDynamicWorkflowConfigMockEnv(
  environment: Record<string, string | undefined>,
  baseUrl: string,
): void {
  for (const key of ["ZCODE_BASE_URL", "ZCODE_TEST_BASE_URL", "ZCODE_ENDPOINT_ORIGIN"] as const) {
    if (environment[key] === baseUrl) {
      delete environment[key];
    }
  }
}

export async function startDynamicWorkflowConfigMockServer(
  scenario: DynamicWorkflowConfigMockScenario,
): Promise<DynamicWorkflowConfigMockServer> {
  // client/configs 是多个启动功能共享的配置源；只改 dynamicWorkflow 一个键，其余保持完整
  // fixture，避免套餐静态目录等无关消费者在 E2E 里进入错误降级。
  const clientConfigFixtureUrl = new URL(
    "../fixtures/coding-plan-client-configs.json",
    import.meta.url,
  );
  const clientConfigPayload = JSON.parse(
    await readFile(clientConfigFixtureUrl, "utf8"),
  ) as DynamicWorkflowClientConfigFixture;
  if (scenario !== "disabled") {
    clientConfigPayload.data.configs.dynamicWorkflow = { mode: scenario };
  } else {
    // disabled 档位走「服务端成功但不下发该 key」这条路径：这是线上关闭灰度的真实形状，
    // 显式写 mode:"disabled" 会掩盖缺省解析（fail-closed）的回归。
    delete clientConfigPayload.data.configs.dynamicWorkflow;
  }
  const mode = clientConfigPayload.data.configs.dynamicWorkflow?.mode ?? null;

  let configRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === DYNAMIC_WORKFLOW_CONFIG_MOCK_STATUS_PATH) {
      sendJson(response, {
        configRequests,
        mode,
        scenario,
      } satisfies DynamicWorkflowConfigMockStatus);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/client/configs") {
      configRequests += 1;
      sendJson(response, clientConfigPayload);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v1/zcode-plan/billing/balance") {
      // 灰度 E2E 不验证套餐；返回合法的「无套餐」快照，避免共享 endpoint 产生无关 404。
      sendJson(response, {
        code: 0,
        data: { balances: [], plans: [] },
        msg: "",
        success: true,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/v2/releases/latest") {
      // provider preset 同步与 client/configs 共享 endpoint；返回固定 config_version，
      // 让它继续复用本地 fixture，不因为灰度 mock 而等待远端超时。
      sendJson(response, {
        config_version: "0.0.13",
        version: "0.25.1",
      });
      return;
    }

    sendJson(
      response,
      {
        code: 404,
        data: null,
        msg: `Unhandled dynamic workflow gray E2E path: ${request.method} ${url.pathname}`,
      },
      404,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Dynamic workflow gray E2E mock server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    scenario,
    stop: async () => {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}

interface DynamicWorkflowClientConfigFixture {
  data: {
    configs: Record<string, unknown> & {
      dynamicWorkflow?: {
        mode: DynamicWorkflowMode;
      };
    };
  };
}

function sendJson(response: ServerResponse, payload: unknown, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
