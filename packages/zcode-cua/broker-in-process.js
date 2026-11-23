import { CuaHelperError } from "./broker.js";

export async function startInProcessComputerUseBroker(_options) {
  throw new CuaHelperError("Computer Use is not available in this build.");
}
