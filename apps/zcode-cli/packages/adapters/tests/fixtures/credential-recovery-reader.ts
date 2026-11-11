import { readFile } from "node:fs/promises";
import { withCredentialFileRead } from "@zcode/shared/node";

try {
  await withCredentialFileRead(process.argv[2]!, async () => {
    const value = await readFile(process.argv[2]!, "utf8");
    const resume = new Promise<void>((resolve) => process.once("message", () => resolve()));
    process.send?.({ type: "admitted" });
    await resume;
    return value;
  });
  process.send?.({ type: "unexpected-success" });
} catch (error) {
  process.send?.({ type: "failed", code: (error as { code?: string }).code });
} finally {
  process.disconnect?.();
}
