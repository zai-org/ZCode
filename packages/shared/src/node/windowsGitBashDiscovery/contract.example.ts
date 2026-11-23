import { discoverWindowsGitBash } from "./contract.js";

export async function exampleWindowsGitBashDiscovery(): Promise<string | undefined> {
  const installation = await discoverWindowsGitBash({
    env: process.env,
    platform: process.platform,
  });
  return installation?.path;
}
