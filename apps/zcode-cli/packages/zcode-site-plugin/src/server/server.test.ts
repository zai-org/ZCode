import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMANDS_URI,
  DELETE_SITE_TOOL,
  PANEL_URI,
  RENAME_SITE_TOOL,
  SET_SITE_BADGE_TOOL,
} from "../contract.ts";
import { OFFICIAL_MCP_AUTH_META_KEY, type SitesApi } from "./api.ts";
import { createSitesServer } from "./server.ts";

const commandsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../commands",
);
const SITE = "1978123456789012480";
const meta = {
  [OFFICIAL_MCP_AUTH_META_KEY]: {
    ok: true,
    headers: { Authorization: "Bearer jwt" },
  },
};

const textOf = (content: { text: string } | { blob: string }) =>
  "text" in content ? content.text : "";

let dir: string;
let client: Client;
let api: ReturnType<typeof vi.fn<SitesApi>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zcode-site-server-"));
  await writeFile(join(dir, "panel.html"), "<html>panel</html>");
  api = vi.fn<SitesApi>(async () => ({ data: { id: SITE } }));
  const server = createSitesServer({
    version: "0.4.0",
    api,
    panelPath: join(dir, "panel.html"),
    commandsDir,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Sites MCP server", () => {
  it("has no instructions and only app-visible tools", async () => {
    expect(client.getInstructions()).toBeUndefined();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      RENAME_SITE_TOOL,
      SET_SITE_BADGE_TOOL,
      DELETE_SITE_TOOL,
    ]);
    for (const tool of tools)
      expect(tool._meta).toEqual({ ui: { visibility: ["app"] } });
  });

  it("serves the panel with clipboard permission", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([PANEL_URI]);
    const { contents } = await client.readResource({ uri: PANEL_URI });
    expect(contents[0]).toMatchObject({
      text: "<html>panel</html>",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { permissions: { clipboardWrite: {} } } },
    });
  });

  it("reads data resources with the message's auth meta", async () => {
    const { contents } = await client.readResource({
      uri: `zcode-site://sites/${SITE}/deployments?cursor=c`,
      _meta: meta,
    });
    expect(JSON.parse(textOf(contents[0]))).toEqual({ data: { id: SITE } });
    expect(contents[0].mimeType).toBe("application/json");
    const [authMeta, method, path] = api.mock.calls[0];
    expect(authMeta).toMatchObject(meta);
    expect([method, path]).toEqual([
      "GET",
      `/api/v1/sites/${SITE}/deployments?cursor=c`,
    ]);
  });

  it("lists commands from the plugin", async () => {
    const { contents } = await client.readResource({ uri: COMMANDS_URI });
    const { data } = JSON.parse(textOf(contents[0]));
    expect(data.map((command: { name: string }) => command.name)).toContain(
      "site-deploy",
    );
    expect(api).not.toHaveBeenCalled();
  });

  it("rejects resources outside the contract", async () => {
    await expect(
      client.readResource({ uri: "zcode-site://sites/1/settings" }),
    ).rejects.toThrow(/Unknown resource/);
    expect(api).not.toHaveBeenCalled();
  });

  it("maps the tools to PATCH and marks failures", async () => {
    await client.callTool({
      name: RENAME_SITE_TOOL,
      arguments: { siteId: SITE, name: "New" },
      _meta: meta,
    });
    await client.callTool({
      name: SET_SITE_BADGE_TOOL,
      arguments: { siteId: SITE, hidden: true },
    });
    expect(
      api.mock.calls.map(([, method, path, body]) => [method, path, body]),
    ).toEqual([
      ["PATCH", `/api/v1/sites/${SITE}`, { name: "New" }],
      ["PATCH", `/api/v1/sites/${SITE}`, { badgeHidden: true }],
    ]);
    api.mockResolvedValueOnce({ error: { code: 3608 } });
    const result = await client.callTool({
      name: SET_SITE_BADGE_TOOL,
      arguments: { siteId: SITE, hidden: true },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 3608 } },
    });
  });

  it("maps delete to DELETE", async () => {
    await client.callTool({
      name: DELETE_SITE_TOOL,
      arguments: { siteId: SITE },
    });
    expect(
      api.mock.calls.map(([, method, path, body]) => [method, path, body]),
    ).toEqual([["DELETE", `/api/v1/sites/${SITE}`, undefined]]);
  });

  it("rejects bad tool arguments without calling the API", async () => {
    await expect(
      client.callTool({
        name: RENAME_SITE_TOOL,
        arguments: { siteId: "../1", name: "x" },
      }),
    ).rejects.toThrow();
    await expect(
      client.callTool({
        name: SET_SITE_BADGE_TOOL,
        arguments: { siteId: SITE, hidden: "yes" },
      }),
    ).rejects.toThrow();
    await expect(
      client.callTool({ name: DELETE_SITE_TOOL, arguments: { siteId: "0" } }),
    ).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });
});
