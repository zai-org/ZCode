import type { CredentialCipher } from "./contract.js";
export async function credentialCipherExample(cipher: CredentialCipher): Promise<boolean> {
  const encrypted = await cipher.encrypt("example");
  return (await cipher.decrypt(encrypted)) === "example";
}
