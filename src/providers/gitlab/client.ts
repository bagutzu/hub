import { z } from "zod";
import type {
  Database,
  GitlabConnectionRecord,
  GitlabNamespace,
  GitlabProjectInput,
} from "../../db/types.js";

/** `api` is the only GitLab scope that reads projects and writes notes and awards. */
export const GITLAB_REQUIRED_SCOPES = ["api"] as const;
export const DEFAULT_GITLAB_URL = "https://gitlab.com";
/** Maintainer. Below it a user cannot register the project webhooks a connection needs. */
const GITLAB_MINIMUM_ACCESS_LEVEL = 40;
const GITLAB_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const PAGE_SIZE = 100;

const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().finite().positive().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

const UserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(1),
  name: z.string().min(1),
  namespace_id: z.number().int().positive().nullable().optional(),
});

const GroupSchema = z.object({
  id: z.number().int().positive(),
  full_path: z.string().min(1),
  name: z.string().min(1),
});

const NamespaceSchema = z.object({
  id: z.number().int().positive(),
  kind: z.string(),
});

const ProjectSchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string().min(1),
  default_branch: z.string().min(1).nullable().optional(),
  web_url: z.string().url(),
  namespace: z.object({ id: z.number().int().positive() }).optional(),
});

const AwardSchema = z.object({ id: z.number().int().positive() });

export const GitlabGrantSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  accessTokenExpiresAt: z.coerce.date().nullable(),
  scopes: z.array(z.string()),
  user: z.object({
    id: z.number().int().positive(),
    username: z.string().min(1),
    name: z.string().min(1),
    namespaceId: z.number().int().positive().nullable(),
  }),
});

/** What one authorization leaves Hub with, before a namespace has been chosen for it. */
export type GitlabGrant = z.infer<typeof GitlabGrantSchema>;

export interface GitlabTokenRefresh {
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes?: string[];
}

export interface GitlabConnectionClient {
  authorizationUrl(input: { state: string; challenge: string }): string;
  exchangeCode(input: { code: string; verifier: string }): Promise<GitlabGrant>;
  refresh(refreshToken: string): Promise<GitlabTokenRefresh>;
  revoke(accessToken: string): Promise<void>;
  /** Groups the grant holder maintains, plus their personal namespace when GitLab reports it. */
  listNamespaces(accessToken: string, user: GitlabGrant["user"]): Promise<GitlabNamespace[]>;
  listProjects(
    accessToken: string,
    namespace: GitlabNamespace,
    userId: number,
  ): Promise<GitlabProjectInput[]>;
}

export interface GitlabItemRef {
  type: "issue" | "merge_request";
  iid: number;
}

export type GitlabAwardName = "eyes" | "thumbsup" | "thumbsdown";

interface GitlabAwardTarget {
  namespaceId: number;
  projectId: number;
  item: GitlabItemRef;
  /** An award on one of the item's notes rather than on the item itself. */
  noteId: number | null;
}

export interface GitlabApiClient {
  listProjects(namespaceId: number): Promise<GitlabProjectInput[]>;
  createNote(input: {
    namespaceId: number;
    projectId: number;
    item: GitlabItemRef;
    body: string;
  }): Promise<void>;
  createAward(input: GitlabAwardTarget & { name: GitlabAwardName }): Promise<{ id: number }>;
  deleteAward(input: GitlabAwardTarget & { awardId: number }): Promise<void>;
}

export function normalizeGitlabUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid GitLab URL");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("invalid GitLab URL");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

export function hasRequiredGitlabScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return GITLAB_REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

export function gitlabConnectionRequiresReauthorization(
  connection: Pick<GitlabConnectionRecord, "scopes" | "refreshToken" | "accessTokenExpiresAt">,
  now = new Date(),
): boolean {
  return (
    !hasRequiredGitlabScopes(connection.scopes) ||
    (connection.refreshToken === null && !hasUsableGitlabAccessToken(connection, now))
  );
}

function hasUsableGitlabAccessToken(
  connection: Pick<GitlabConnectionRecord, "accessTokenExpiresAt">,
  now: Date,
): boolean {
  const expiresAt = connection.accessTokenExpiresAt;
  return (
    expiresAt === null || expiresAt.getTime() > now.getTime() + GITLAB_ACCESS_TOKEN_REFRESH_SKEW_MS
  );
}

export function createGitlabConnectionClient(options: {
  url: string;
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): GitlabConnectionClient {
  const request = options.fetch ?? fetch;
  const base = normalizeGitlabUrl(options.url);
  const redirectUri = new URL(
    "/api/integrations/gitlab/callback",
    options.publicBaseUrl,
  ).toString();
  const now = options.now ?? (() => new Date());

  const exchange = async (values: Record<string, string>) => {
    const response = await request(`${base}/oauth/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: redirectUri,
        ...values,
      }),
    });
    if (!response.ok) throw new Error(`GitLab OAuth HTTP ${response.status}`);
    const token = TokenResponseSchema.parse(await response.json());
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      accessTokenExpiresAt:
        token.expires_in === undefined
          ? null
          : new Date(now().getTime() + token.expires_in * 1_000),
      scopes: parseGitlabScopes(token.scope),
    };
  };

  return {
    authorizationUrl({ state, challenge }) {
      const parameters = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        scope: GITLAB_REQUIRED_SCOPES.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return `${base}/oauth/authorize?${parameters.toString()}`;
    },
    async exchangeCode({ code, verifier }) {
      const token = await exchange({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      });
      const user = UserSchema.parse(await api(request, base, token.accessToken, "/user"));
      return {
        ...token,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          namespaceId:
            user.namespace_id ??
            (await personalNamespaceId(request, base, token.accessToken, user.username)),
        },
      };
    },
    async refresh(refreshToken) {
      const token = await exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
      return {
        accessToken: token.accessToken,
        ...(token.refreshToken === null ? {} : { refreshToken: token.refreshToken }),
        accessTokenExpiresAt: token.accessTokenExpiresAt,
        ...(token.scopes.length === 0 ? {} : { scopes: token.scopes }),
      };
    },
    async revoke(accessToken) {
      const response = await request(`${base}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          token: accessToken,
        }),
      });
      if (!response.ok) throw new Error(`GitLab revoke HTTP ${response.status}`);
    },
    listNamespaces: (accessToken, user) => listNamespaces(request, base, accessToken, user),
    listProjects: (accessToken, namespace, userId) =>
      listProjects(request, base, accessToken, namespace, userId),
  };
}

/**
 * Finds credentials through the GitLab namespace ID, which is what the connection table is keyed
 * by and what a project's webhook payload can be traced back to.
 */
export function createGitlabApiClient(options: {
  url: string;
  connectionForNamespace(namespaceId: number): Promise<GitlabConnectionRecord | undefined>;
  withGitlabConnectionRefresh: Database["withGitlabConnectionRefresh"];
  connectionClient: Pick<GitlabConnectionClient, "refresh" | "listProjects">;
  fetch?: typeof fetch;
  now?: () => Date;
}): GitlabApiClient {
  const now = options.now ?? (() => new Date());
  // Avoid duplicate local work; the database transaction is the cross-process source of truth
  // for refresh serialization. A GitLab refresh retires the previous refresh token, so two
  // processes refreshing at once would leave one of them with a dead pair.
  const refreshes = new Map<string, Promise<string>>();

  const accessTokenFor = async (namespaceId: number): Promise<string> => {
    const connection = await options.connectionForNamespace(namespaceId);
    if (connection === undefined) throw new Error("GitLab connection unavailable");
    if (hasUsableGitlabAccessToken(connection, now())) return connection.accessToken;
    if (connection.refreshToken === null)
      throw new Error("GitLab connection requires reauthorization");
    const existing = refreshes.get(connection.id);
    if (existing !== undefined) return existing;
    const pending = options.withGitlabConnectionRefresh(
      namespaceId,
      async (current, updateTokens) => {
        if (current === undefined) throw new Error("GitLab connection unavailable");
        if (hasUsableGitlabAccessToken(current, now())) return current.accessToken;
        if (current.refreshToken === null)
          throw new Error("GitLab connection requires reauthorization");
        const refreshed = await options.connectionClient.refresh(current.refreshToken);
        await updateTokens(refreshed);
        return refreshed.accessToken;
      },
    );
    refreshes.set(connection.id, pending);
    try {
      return await pending;
    } finally {
      if (refreshes.get(connection.id) === pending) refreshes.delete(connection.id);
    }
  };

  const base = normalizeGitlabUrl(options.url);
  const request = options.fetch ?? fetch;
  const send = async (
    namespaceId: number,
    method: "POST" | "DELETE",
    path: string,
    body?: Record<string, string>,
  ): Promise<Response> => {
    const response = await request(`${base}/api/v4${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await accessTokenFor(namespaceId)}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitLab API HTTP ${response.status}`);
    return response;
  };

  return {
    async listProjects(namespaceId) {
      const connection = await options.connectionForNamespace(namespaceId);
      if (connection === undefined) throw new Error("GitLab connection unavailable");
      return options.connectionClient.listProjects(
        await accessTokenFor(namespaceId),
        connection.namespace,
        connection.user.id,
      );
    },
    async createNote({ namespaceId, projectId, item, body }) {
      await send(namespaceId, "POST", `${itemPath(projectId, item)}/notes`, { body });
    },
    async createAward({ namespaceId, projectId, item, noteId, name }) {
      const response = await send(namespaceId, "POST", awardPath(projectId, item, noteId), {
        name,
      });
      return { id: AwardSchema.parse(await response.json()).id };
    },
    async deleteAward({ namespaceId, projectId, item, noteId, awardId }) {
      await send(namespaceId, "DELETE", `${awardPath(projectId, item, noteId)}/${String(awardId)}`);
    },
  };
}

/** gitlab.com leaves `namespace_id` out of `/user`; the personal namespace sits at the username. */
async function personalNamespaceId(
  request: typeof fetch,
  base: string,
  accessToken: string,
  username: string,
): Promise<number | null> {
  const namespace = NamespaceSchema.parse(
    await api(request, base, accessToken, `/namespaces/${encodeURIComponent(username)}`),
  );
  return namespace.kind === "user" ? namespace.id : null;
}

function itemPath(projectId: number, item: GitlabItemRef): string {
  const collection = item.type === "issue" ? "issues" : "merge_requests";
  return `/projects/${String(projectId)}/${collection}/${String(item.iid)}`;
}

function awardPath(projectId: number, item: GitlabItemRef, noteId: number | null): string {
  const subject =
    noteId === null
      ? itemPath(projectId, item)
      : `${itemPath(projectId, item)}/notes/${String(noteId)}`;
  return `${subject}/award_emoji`;
}

async function listNamespaces(
  request: typeof fetch,
  base: string,
  accessToken: string,
  user: GitlabGrant["user"],
): Promise<GitlabNamespace[]> {
  const groups = await paginate(
    request,
    base,
    accessToken,
    `/groups?min_access_level=${GITLAB_MINIMUM_ACCESS_LEVEL}`,
    GroupSchema,
  );
  const namespaces: GitlabNamespace[] = groups.map((group) => ({
    id: group.id,
    kind: "group",
    fullPath: group.full_path,
    name: group.name,
  }));
  if (user.namespaceId !== null) {
    namespaces.push({
      id: user.namespaceId,
      kind: "user",
      fullPath: user.username,
      name: user.name,
    });
  }
  return namespaces.sort((left, right) => left.fullPath.localeCompare(right.fullPath));
}

async function listProjects(
  request: typeof fetch,
  base: string,
  accessToken: string,
  namespace: GitlabNamespace,
  userId: number,
): Promise<GitlabProjectInput[]> {
  const projects =
    namespace.kind === "group"
      ? await paginate(
          request,
          base,
          accessToken,
          `/groups/${namespace.id}/projects?include_subgroups=true&archived=false&simple=true`,
          ProjectSchema,
        )
      : (
          await paginate(
            request,
            base,
            accessToken,
            `/users/${userId}/projects?archived=false&simple=true`,
            ProjectSchema,
          )
        ).filter((project) => project.namespace?.id === namespace.id);
  return projects
    .map((project) => ({
      projectId: project.id,
      pathWithNamespace: project.path_with_namespace,
      defaultBranch: project.default_branch ?? null,
      webUrl: project.web_url,
    }))
    .sort((left, right) => left.pathWithNamespace.localeCompare(right.pathWithNamespace));
}

async function paginate<T>(
  request: typeof fetch,
  base: string,
  accessToken: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  for (;;) {
    const response = await apiResponse(
      request,
      base,
      accessToken,
      `${path}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    items.push(...z.array(schema).parse(await response.json()));
    const next = response.headers.get("x-next-page");
    if (next === null || next === "") return items;
    page = Number(next);
    if (!Number.isSafeInteger(page) || page <= 0) return items;
  }
}

async function api(
  request: typeof fetch,
  base: string,
  accessToken: string,
  path: string,
): Promise<unknown> {
  return (await apiResponse(request, base, accessToken, path)).json();
}

async function apiResponse(
  request: typeof fetch,
  base: string,
  accessToken: string,
  path: string,
): Promise<Response> {
  const response = await request(`${base}/api/v4${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`GitLab API HTTP ${response.status}`);
  return response;
}

function parseGitlabScopes(scope: string | undefined): string[] {
  return [
    ...new Set(
      (scope ?? "")
        .split(/[\s,]+/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}
