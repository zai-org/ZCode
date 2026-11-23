export interface WindowsGitBashInstallation {
  path: string;
  source: "system" | "path";
}

export interface WindowsGitBashDiscoveryOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform | string;
  isExecutable?: (path: string) => boolean | Promise<boolean>;
  readRegistryInstallRoots?: () => Promise<string[]>;
  readTextFile?: (path: string) => Promise<string>;
}
