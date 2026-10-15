import { z } from "zod";

const CONNECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RESERVED_ENVIRONMENT_KEYS = new Set([
  "GITLAB_TOKEN",
  "GITLAB_HOST",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
]);
const INDEXED_GIT_CONFIG_KEY = /^GIT_CONFIG_(?:KEY|VALUE)_[0-9]+$/u;

/**
 * A GitLab OAuth grant cannot be narrowed: no repository list, no permission set, no shorter
 * lease. The connection is the whole boundary, so it is the only key.
 */
export interface AuthoredGitlabAuthority {
  connection: string;
}

export type CompiledGitlabAuthority = AuthoredGitlabAuthority;

export const AuthoredGitlabAuthoritySchema = z
  .object({ connection: z.string().regex(CONNECTION_SLUG) })
  .strict();

export const CompiledGitlabAuthoritySchema: z.ZodType<CompiledGitlabAuthority> =
  AuthoredGitlabAuthoritySchema;

export function compileGitlabAuthority(
  value: AuthoredGitlabAuthority,
  path: string,
): CompiledGitlabAuthority {
  validateGitlabAuthority(value, path);
  return { connection: value.connection };
}

export function validateGitlabAuthority(value: CompiledGitlabAuthority, path: string): void {
  if (!CONNECTION_SLUG.test(value.connection)) {
    throw new Error(`${path}.connection must be a connection slug`);
  }
}

export function isGitlabAuthorityEnvironmentKey(key: string): boolean {
  return RESERVED_ENVIRONMENT_KEYS.has(key) || INDEXED_GIT_CONFIG_KEY.test(key);
}
