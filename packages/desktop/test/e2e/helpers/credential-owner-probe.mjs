import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";

const path = process.env.ZCODE_E2E_CREDENTIAL_OWNER_LOG;
if (!path) throw new Error("Credential owner probe requires its isolated output path");
const role = process.type ?? "node";
await mkdir(dirname(path), { recursive: true });
const record = (event) =>
  appendFile(path, `${JSON.stringify({ event, role, pid: process.pid })}\n`);
await record("loaded");
// 不接触真实系统钥匙串；Host/CLI 一旦直接读取就失败，不能被合成密钥掩盖。
AsyncEntry.prototype.getPassword = async function () {
  await record("get");
  if (role !== "browser") throw new Error("Only Desktop Main may access the key store");
  return Buffer.alloc(32, 9).toString("base64url");
};
AsyncEntry.prototype.setPassword = async function () {
  await record("set");
  throw new Error("The synthetic key already exists");
};
