export function escapePowerShellLiteral(value: string): string;
export function createEncodedPowerShellArgs(script: string, values?: readonly string[]): string[];
export function createWindowsPowerShellSecurityArgs(
  script: string,
  values?: readonly string[],
): string[];

export function readWindowsAuthenticodeSignature(
  filePath: string,
): Promise<{ status: number; subject: string | null }>;
export function verifyWindowsAuthenticodeSignature(filePath: string): Promise<string | null>;
