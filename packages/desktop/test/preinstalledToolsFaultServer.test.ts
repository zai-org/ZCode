import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extract } from "tar";
import { createHash } from "node:crypto";
import { startPreinstalledToolsRealFixture } from "#e2e/helpers/preinstalled-tools-real-fixture";
import { startPreinstalledToolsRewriteFixture } from "#e2e/helpers/preinstalled-tools-rewrite-fixture";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPreinstalledToolsFixture } from "#e2e/helpers/preinstalled-tools-fixture";
import { startPreinstalledToolsFaultServer } from "#e2e/helpers/preinstalled-tools-fault-server";

const payload = Buffer.from("0123456789abcdef");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function start() {
  const directory = await mkdtemp(join(tmpdir(), "preinstall-http-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await startPreinstalledToolsFaultServer({
    resources: { sample: payload },
    directory,
  });
  cleanup.push(server.stop);
  return server;
}

describe("预装下载故障服务的公开 HTTP 行为", () => {
  it.skipIf(process.platform !== "darwin")(
    "改写夹具在同一报告根保持独立清单和HTTP资源",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "preinstall-rewrite-fixture-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const first = await startPreinstalledToolsRewriteFixture(directory);
      cleanup.push(first.stop);
      const second = await startPreinstalledToolsRewriteFixture(directory);
      cleanup.push(second.stop);
      expect(first.catalogPath).not.toBe(second.catalogPath);
      await fetch(`${first.url}/scenario/success`);
      expect(
        JSON.parse(await readFile(first.catalogPath, "utf8"))[0].resources[0].rewrite,
      ).toBeDefined();
      expect(
        JSON.parse(await readFile(second.catalogPath, "utf8"))[0].resources[0].rewrite,
      ).toBeUndefined();
      const response = await fetch(`${first.url}/archive/success`);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(await (await fetch(`${first.url}/status`)).json()).toMatchObject({
        requests: ["success"],
      });
      expect(await (await fetch(`${second.url}/status`)).json()).toMatchObject({ requests: [] });
      const held = await fetch(`${first.url}/archive/signing-failure`);
      const reader = held.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      expect(await (await fetch(`${first.url}/status`)).json()).toMatchObject({
        pending: ["signing-failure"],
      });
      await fetch(`${first.url}/release/signing-failure`);
      while (!(await reader.read()).done) {
        /* 消费真实响应直到释放完成。 */
      }
    },
    60000,
  );
  // 此夹具归档使用 POSIX sh；Windows 原生入口由独立平台验收覆盖。
  it.skipIf(process.platform === "win32")(
    "升级夹具通过真实命令报告执行路径，不把清单版本当运行证据",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "preinstall-upgrade-fixture-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const fixture = await startPreinstalledToolsFixture(directory);
      cleanup.push(fixture.stop);
      await fetch(`${fixture.url}/release`);
      await fetch(`${fixture.url}/finish-check`);
      const response = await fetch(`${fixture.url}/archive`);
      const archive = join(directory, "archive.tar.gz");
      await writeFile(archive, Buffer.from(await response.arrayBuffer()));
      const installation = join(directory, "中文 升级目录");
      await mkdir(installation);
      await extract({ file: archive, cwd: installation });
      const executable = join(installation, "bin/soffice");
      const { stdout } = await promisify(execFile)(executable, ["--fixture-location"]);
      expect(stdout.trim()).toBe(executable);
    },
  );
  it("多工具夹具按工具隔离下载释放与运行检查", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preinstall-multi-fixture-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const fixture = await startPreinstalledToolsFixture(directory, ["qpdf", "libreoffice"]);
    cleanup.push(fixture.stop);
    const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
    expect(catalog.map((tool: { toolId: string }) => tool.toolId)).toEqual(["qpdf", "libreoffice"]);
    await fetch(`${fixture.url}/qpdf/release`);
    const archive = await fetch(`${fixture.url}/qpdf/archive`);
    expect((await archive.arrayBuffer()).byteLength).toBe(
      catalog[0].resources[0].archive.sizeBytes,
    );
    expect(await (await fetch(`${fixture.url}/status`)).json()).toMatchObject({
      requests: 1,
      tools: { qpdf: { requests: 1 }, libreoffice: { requests: 0 } },
    });
    await fetch(`${fixture.url}/qpdf/finish-check`);
    expect(await (await fetch(`${fixture.url}/qpdf/runtime-check`)).text()).toContain(
      "qpdf fixture",
    );
  });
  it("返回错误状态、正常截断与超长内容，保留独立请求记录", async () => {
    const server = await start();
    const error = await fetch(`${server.url}/resources/sample/http-error`);
    expect(error.status).toBe(503);
    await error.arrayBuffer();
    const truncated = await fetch(`${server.url}/resources/sample/truncated`);
    expect(truncated.status).toBe(200);
    expect(await truncated.text()).toBe("01234567");
    const oversized = await fetch(`${server.url}/resources/sample/oversize`);
    expect(Buffer.from(await oversized.arrayBuffer())).toEqual(
      Buffer.concat([payload, Buffer.from("x")]),
    );
    const status = await (await fetch(`${server.url}/status`)).json();
    expect(status.requests.map((request: { mode: string }) => request.mode)).toEqual([
      "http-error",
      "truncated",
      "oversize",
    ]);
  });
  it("按候选序号返回预设故障，未声明的候选不提供内容", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preinstall-http-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const server = await startPreinstalledToolsFaultServer({
      resources: { sample: payload },
      directory,
      candidates: { sample: ["http-error", "complete"] },
    });
    cleanup.push(server.stop);
    const first = await fetch(`${server.url}/candidates/0/sample`);
    expect(first.status).toBe(503);
    await first.arrayBuffer();
    const second = await fetch(`${server.url}/candidates/1/sample`);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(payload);
    const missing = await fetch(`${server.url}/candidates/2/sample`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
    const status = await (await fetch(`${server.url}/status`)).json();
    expect(status.requests.map((request: { mode: string }) => request.mode)).toEqual([
      "http-error",
      "complete",
    ]);
  });
  it("逐块放行慢速响应，并在真实连接断开时让读取方失败", async () => {
    const server = await start();
    const slow = await fetch(`${server.url}/resources/sample/slow`);
    const reader = slow.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("0123");
    await fetch(`${server.url}/step/1`);
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("4567");
    await fetch(`${server.url}/release/1`);
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("89abcdef");
    expect((await reader.read()).done).toBe(true);
    const interrupted = await fetch(`${server.url}/resources/sample/interrupt`);
    const partial = interrupted.body!.getReader();
    expect(Buffer.from((await partial.read()).value!).toString()).toBe("01234567");
    await fetch(`${server.url}/break/2`);
    await expect(partial.read()).rejects.toThrow();
  });
  it("同一报告根下的连续夹具保留独立归档与 HTTP 状态", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preinstall-fixture-isolation-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const first = await startPreinstalledToolsFixture(directory);
    cleanup.push(first.stop);
    const second = await startPreinstalledToolsFixture(directory);
    cleanup.push(second.stop);
    expect(first.catalogPath).not.toBe(second.catalogPath);
    await fetch(`${first.url}/release`);
    const body = await fetch(`${first.url}/archive`);
    expect((await body.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(await (await fetch(`${first.url}/status`)).json()).toMatchObject({ requests: 1 });
    expect(await (await fetch(`${second.url}/status`)).json()).toMatchObject({ requests: 0 });
  });
});

describe("真实归档 loopback 夹具", () => {
  it("提前断开不记完成，正常finish与close不会重复减少活动数", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preinstall-real-disconnect-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const bytes = Buffer.alloc(90000, 4);
    const artifactPath = join(directory, "disconnect.artifact.json");
    await writeFile(
      artifactPath,
      JSON.stringify({
        resource: {
          toolId: "qpdf",
          resourceId: "disconnect-r1",
          archive: {
            format: "tar.gz",
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      }),
    );
    await writeFile(join(directory, "disconnect.tar.gz"), bytes);
    const server = await startPreinstalledToolsRealFixture(directory, artifactPath);
    cleanup.push(server.stop);
    const response = await fetch(`${server.url}/archive`);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    const status = async () => (await fetch(`${server.url}/status`)).json();
    await expect.poll(status).toMatchObject({ requests: 1, active: 0, held: 0, completed: 0 });
    await fetch(`${server.url}/release`);
    expect(Buffer.from(await (await fetch(`${server.url}/archive`)).arrayBuffer())).toEqual(bytes);
    await expect
      .poll(status)
      .toMatchObject({ requests: 2, active: 0, held: 0, completed: 1, maxActive: 1 });
  });
  it("多资源保持清单顺序、独立屏障与原字节，升级只替换目标资源", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preinstall-real-multi-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    async function artifact(toolId: string, resourceId: string, byte: number) {
      const bytes = Buffer.alloc(90000, byte);
      const path = join(directory, `${resourceId}.artifact.json`);
      await writeFile(
        path,
        JSON.stringify({
          resource: {
            toolId,
            resourceId,
            archive: {
              format: "tar.gz",
              sizeBytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        }),
      );
      await writeFile(path.replace(".artifact.json", ".tar.gz"), bytes);
      return { path, bytes };
    }
    const python = await artifact("python", "python-r1", 3);
    const qpdf = await artifact("qpdf", "qpdf-r1", 5);
    const upgrade = await artifact("qpdf", "qpdf-r2", 9);
    const server = await startPreinstalledToolsRealFixture(
      directory,
      [python.path, qpdf.path],
      upgrade.path,
    );
    cleanup.push(server.stop);
    const catalog = JSON.parse(await readFile(server.catalogPath, "utf8"));
    expect(catalog.map((tool: { toolId: string }) => tool.toolId)).toEqual(["python", "qpdf"]);
    const pending = await fetch(`${server.url}/archive/python-r1`);
    const reader = pending.body!.getReader();
    const first = (await reader.read()).value!;
    expect(await (await fetch(`${server.url}/status`)).json()).toMatchObject({
      held: 1,
      completed: 0,
      tools: { python: { requests: 1 }, qpdf: { requests: 0 } },
    });
    await fetch(`${server.url}/release/python-r1`);
    const chunks = [Buffer.from(first)];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    expect(Buffer.concat(chunks)).toEqual(python.bytes);
    await fetch(`${server.url}/upgrade`);
    const next = JSON.parse(await readFile(server.catalogPath, "utf8"));
    expect(next[0]).toEqual(catalog[0]);
    expect(next[1].resources[0].resourceId).toBe("qpdf-r2");
    await fetch(`${server.url}/release/qpdf-r2`);
    expect(Buffer.from(await (await fetch(`${server.url}/archive/qpdf-r2`)).arrayBuffer())).toEqual(
      upgrade.bytes,
    );
    expect(await (await fetch(`${server.url}/status`)).json()).toMatchObject({
      requests: 2,
      completed: 2,
      active: 0,
      maxActive: 1,
      events: expect.arrayContaining([
        expect.objectContaining({ event: "requested", resourceId: "python-r1" }),
        expect.objectContaining({ event: "requested", resourceId: "qpdf-r2" }),
      ]),
    });
  });
  it("仅放行后流式完成原始字节，manifest 保留身份与摘要", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preinstall-real-stream-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const archive = Buffer.alloc(200000, 7);
    const resource = {
      toolId: "libreoffice",
      resourceId: "real-test",
      archive: {
        format: "tar.gz",
        sizeBytes: archive.length,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
    };
    const artifactPath = join(directory, "sample.artifact.json");
    await writeFile(artifactPath, JSON.stringify({ resource }));
    await writeFile(join(directory, "sample.tar.gz"), archive);
    const server = await startPreinstalledToolsRealFixture(directory, artifactPath);
    cleanup.push(server.stop);
    expect(server.cdnBaseUrl).toBe(server.url);
    const manifest = JSON.parse(await readFile(server.catalogPath, "utf8"));
    expect(manifest).toEqual([
      {
        toolId: "libreoffice",
        displayName: "libreoffice",
        resources: [
          {
            ...resource,
            archive: { ...resource.archive, path: "archive" },
          },
        ],
      },
    ]);
    const response = await fetch(`${server.url}/archive`);
    const reader = response.body!.getReader();
    const first = (await reader.read()).value!;
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(archive.length);
    expect(await (await fetch(`${server.url}/status`)).json()).toMatchObject({
      requests: 1,
      held: 1,
      completed: 0,
    });
    await fetch(`${server.url}/release`);
    const chunks = [Buffer.from(first)];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    expect(Buffer.concat(chunks)).toEqual(archive);
    // 正文接收完成可早于源文件关闭；等待服务端 pipeline 完成，避免把客户端读完当作服务端收尾。
    await expect
      .poll(async () => (await fetch(`${server.url}/status`)).json())
      .toMatchObject({
        requests: 1,
        held: 0,
        completed: 1,
      });
  });
});
