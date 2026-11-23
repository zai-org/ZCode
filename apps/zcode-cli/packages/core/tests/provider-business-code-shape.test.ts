import { describe, expect, it } from "vitest";
import { tryCreateProviderBusinessModelErrorFromMetadata } from "../src/runtime/helpers/model-errors.js";

// 回归：上游响应里的 code 字段曾是一整段多行脚本，被当成业务码拼进报错详情（provider_code=<脚本>）。
describe("provider business code shape", () => {
  it("does not treat a multi-line script in code as a provider business code", () => {
    const error = tryCreateProviderBusinessModelErrorFromMetadata({
      gateway: { code: "const root = process.env.ZCODE_PLUGIN_ROOT;\nawait run();" },
    });

    expect(error).toBeUndefined();
  });

  it("keeps numeric provider business codes", () => {
    const error = tryCreateProviderBusinessModelErrorFromMetadata({
      gateway: { code: 3007, msg: "denied" },
    });

    expect(error?.context).toMatchObject({ providerCode: "3007" });
  });
});
