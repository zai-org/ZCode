import { randomUUID } from "node:crypto";
import type { CredentialCipher } from "./contract.js";

import {
  credentialCipherRequestSchema,
  credentialCipherReplySchema,
  credentialPlaintextSchema,
  credentialCiphertextSchema,
  CREDENTIAL_DECRYPT_ERROR_PREFIX,
  type CredentialCipherRequest,
  type CredentialCipherReply,
} from "@zcode/shared";
export {
  credentialCipherRequestSchema,
  credentialCipherReplySchema,
  credentialCipherResultSchema,
  type CredentialCipherRequest,
  type CredentialCipherReply,
} from "@zcode/shared";

/** 只走已建立的可信进程通道；系统主密钥始终留在 owner，不进入消息载荷。 */
export function createCredentialCipherBridge(send: (request: CredentialCipherRequest) => void): {
  cipher: CredentialCipher;
  receive(reply: unknown): void;
  dispose(): void;
} {
  const pending = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
  let disposed = false;
  function request(operation: "encrypt" | "decrypt", value: string): Promise<string> {
    if (disposed) return Promise.reject(new Error("Credential cipher bridge is closed"));
    const message = credentialCipherRequestSchema.parse({
      requestId: randomUUID(),
      operation,
      value,
    });
    return new Promise((resolve, reject) => {
      pending.set(message.requestId, { resolve, reject });
      try {
        send(message);
      } catch (error) {
        pending.delete(message.requestId);
        reject(error instanceof Error ? error : new Error("Credential cipher bridge failed"));
      }
    });
  }
  return {
    cipher: {
      needsMigration: (value) => !value.startsWith("enc:v2:"),
      encrypt: (value) => request("encrypt", value),
      decrypt: (value) => request("decrypt", value),
    },
    receive(reply) {
      const validated = credentialCipherReplySchema.safeParse(reply);
      if (!validated.success) {
        // 非法回复不能只在外层丢弃，否则迁移 Promise 和文件锁都无法结束。
        const id =
          typeof reply === "object" && reply !== null && "requestId" in reply
            ? reply.requestId
            : undefined;
        const error = invalidPayload();
        if (typeof id === "string") {
          pending.get(id)?.reject(error);
          pending.delete(id);
        } else {
          for (const entry of pending.values()) entry.reject(error);
          pending.clear();
        }
        return;
      }
      const parsed = validated.data;
      const entry = pending.get(parsed.requestId);
      if (!entry) return;
      pending.delete(parsed.requestId);
      if (parsed.result.ok) entry.resolve(parsed.result.value);
      else
        entry.reject(
          Object.assign(new Error(parsed.result.error.message), { code: parsed.result.error.code }),
        );
    },
    dispose() {
      disposed = true;
      for (const entry of pending.values())
        entry.reject(new Error("Credential cipher bridge is closed"));
      pending.clear();
    },
  };
}

function invalidPayload(): Error {
  return Object.assign(new Error("Invalid credential cipher payload"), {
    code: "CREDENTIAL_CIPHER_INVALID_PAYLOAD",
  });
}

export async function executeCredentialCipherRequest(
  cipher: CredentialCipher,
  request: CredentialCipherRequest,
): Promise<CredentialCipherReply> {
  const input = credentialCipherRequestSchema.parse(request);
  try {
    const value = await cipher[input.operation](input.value);
    // Main 必须保证成功回复可被接收；不能让加密膨胀变成无终态的等待。
    const schema =
      input.operation === "encrypt" ? credentialCiphertextSchema : credentialPlaintextSchema;
    if (!schema.safeParse(value).success) throw invalidPayload();
    return {
      requestId: input.requestId,
      result: { ok: true, value },
    };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const decryptFailed = code === "ZCODE_CREDENTIAL_DECRYPT_FAILED";
    const invalid = code === "CREDENTIAL_CIPHER_INVALID_PAYLOAD";
    // 只返回受控错误；原生异常可能含系统细节，不能穿过凭据桥或进入日志。
    return {
      requestId: input.requestId,
      result: {
        ok: false,
        error: {
          code: decryptFailed || invalid ? code : "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
          message: invalid
            ? "Invalid credential cipher payload"
            : decryptFailed
              ? `${CREDENTIAL_DECRYPT_ERROR_PREFIX}Invalid encrypted credential`
              : "System credential storage is unavailable. Unlock the OS credential store and restart the application or CLI to retry.",
        },
      },
    };
  }
}
