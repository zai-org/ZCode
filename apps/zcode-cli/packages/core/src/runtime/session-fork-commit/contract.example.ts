import type { ForkIdentityInput } from "./contract.js";
import { createForkIdentityMap } from "./index.js";

/** 先一次分配身份，再由原子提交构建消息、Goal、notice，避免各自生成不一致引用。 */
export function prepareForkIdentityExample(input: ForkIdentityInput) {
  return createForkIdentityMap(input);
}
