export function parseArguments(argv: string[]): { positional: string[]; options: Record<string, string | boolean> };
export function printHelp(command?: string | null): void;
export function runMoodliaSyncCli(argv?: string[]): Promise<void>;
export function reportMoodliaSyncCliError(error: unknown): void;
