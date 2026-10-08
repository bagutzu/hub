export interface ConnectionTokenLease {
  provider: "github" | "gitlab";
  token: string;
  expiresAt: number;
}

export interface ConnectionResolutionContext {
  executionId?: string;
  registerToken?: (lease: ConnectionTokenLease) => Promise<void> | void;
}

export type ConnectionResolver = (
  connectionSlug: string,
  value: string,
  context?: ConnectionResolutionContext,
) => Promise<string> | string;
