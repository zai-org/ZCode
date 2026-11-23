import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { createConversationShareMockRoute } from "#e2e/helpers/conversation-share-mock-route";

it("分享 HTTP Mock 保留 multipart 文件字节和描述，校验真实上传摘要", async () => {
  const route = await createConversationShareMockRoute();
  const server = createServer((request, response) => {
    void route(request, response).catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const base = `http://127.0.0.1:${address.port}/api/v1/shares`;
  const headers = { Authorization: "Bearer test-owner" };
  try {
    const preparationResponse = await fetch(`${base}/preparations`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        client_request_id: "multipart-regression",
        title: "PDF 分享",
        schema_version: 1,
        access_mode: "public_readonly",
        payload_sha256: "a".repeat(64),
        artifact_count: 1,
      }),
    });
    expect(preparationResponse.status).toBe(200);
    const preparation = (await preparationResponse.json()) as {
      data: { preparation_id: string };
    };
    // 非 UTF-8 字节用于证明 HTTP 适配器没有先解码字符串再重新编码文件。
    const bytes = new Uint8Array([37, 80, 68, 70, 255, 0, 128, 10]);
    const descriptor = {
      artifact_id: "share-artifact-1",
      logical_artifact_key: "share-artifact-key-1",
      producer_product_turn_id: "share-product-turn-1",
      artifact_version: 1,
      state: "current",
      ref: "zcode-artifact://share/share-artifact-1",
      artifact_type: "pdf",
      display_name: "报告.pdf",
      extension: "pdf",
      mime_type: "application/pdf",
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const form = new FormData();
    form.set("descriptor", JSON.stringify(descriptor));
    form.set("file", new Blob([bytes], { type: "application/pdf" }), "报告.pdf");
    const uploaded = await fetch(
      `${base}/preparations/${preparation.data.preparation_id}/artifacts`,
      { method: "POST", headers, body: form },
    );
    const result = await uploaded.json();
    expect({ status: uploaded.status, result }).toMatchObject({
      status: 200,
      result: { data: { artifact_id: descriptor.artifact_id, sha256: descriptor.sha256 } },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("分享夹具装载失败在服务器监听前暴露，不留到首个 HTTP 请求", async () => {
  const fixtureUrl = new URL(
    "../../services/test/helpers/conversationShareMockApiClient.ts",
    import.meta.url,
  ).href;
  vi.doMock(fixtureUrl, () => {
    throw new Error("fixture initialization failed");
  });
  try {
    await expect(
      Promise.resolve().then(() => createConversationShareMockRoute()),
    ).rejects.toMatchObject({
      cause: { message: "fixture initialization failed" },
    });
  } finally {
    vi.doUnmock(fixtureUrl);
  }
});
