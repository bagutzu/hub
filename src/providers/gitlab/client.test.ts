import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { GitlabConnectionRecord } from "../../db/types.js";
import {
  createGitlabApiClient,
  createGitlabConnectionClient,
  gitlabConnectionRequiresReauthorization,
  normalizeGitlabUrl,
} from "./client.js";

interface Call {
  url: URL;
  init: RequestInit | undefined;
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response>): {
  request: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { request, calls };
}

function json(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });
}

function form(init: RequestInit | undefined): URLSearchParams {
  const body = init?.body;
  return body instanceof URLSearchParams ? body : new URLSearchParams();
}

function client(request: typeof fetch, now = () => new Date("2026-09-17T10:00:00.000Z")) {
  return createGitlabConnectionClient({
    url: "https://gitlab.example.test/",
    clientId: "app-id",
    clientSecret: "app-secret",
    publicBaseUrl: "https://hub.test",
    fetch: request,
    now,
  });
}

const USER = { id: 7, username: "acme-bot", name: "Acme Bot", namespace_id: 70 };

describe("GitLab connection client", () => {
  it("builds an authorization URL with PKCE and the api scope", () => {
    const url = new URL(
      client(fakeFetch(() => json({})).request).authorizationUrl({
        state: "state-1",
        challenge: "challenge-1",
      }),
    );
    assert.equal(url.origin + url.pathname, "https://gitlab.example.test/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "app-id");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://hub.test/api/integrations/gitlab/callback",
    );
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "api");
    assert.equal(url.searchParams.get("state"), "state-1");
    assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  });

  it("exchanges the code with the PKCE verifier and reads the grant holder", async () => {
    const { request, calls } = fakeFetch(({ url }) => {
      if (url.pathname === "/oauth/token") {
        return json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 7200,
          scope: "api",
        });
      }
      if (url.pathname === "/api/v4/user") return json(USER);
      throw new Error(`unexpected ${url.pathname}`);
    });

    const grant = await client(request).exchangeCode({ code: "code-1", verifier: "verifier-1" });

    const token = form(calls[0]?.init);
    assert.equal(token.get("grant_type"), "authorization_code");
    assert.equal(token.get("code"), "code-1");
    assert.equal(token.get("code_verifier"), "verifier-1");
    assert.equal(token.get("client_id"), "app-id");
    assert.equal(token.get("client_secret"), "app-secret");
    assert.equal(token.get("redirect_uri"), "https://hub.test/api/integrations/gitlab/callback");
    assert.equal(new Headers(calls[1]?.init?.headers).get("authorization"), "Bearer access");
    assert.deepEqual(grant, {
      accessToken: "access",
      refreshToken: "refresh",
      accessTokenExpiresAt: new Date("2026-09-17T12:00:00.000Z"),
      scopes: ["api"],
      user: { id: 7, username: "acme-bot", name: "Acme Bot", namespaceId: 70 },
    });
  });

  it("looks the personal namespace up by username when the user endpoint omits it", async () => {
    const { namespace_id: _omitted, ...bareUser } = USER;
    const { request, calls } = fakeFetch(({ url }) => {
      if (url.pathname === "/oauth/token") return json({ access_token: "access", scope: "api" });
      if (url.pathname === "/api/v4/user") return json(bareUser);
      if (url.pathname === "/api/v4/namespaces/acme-bot") {
        return json({ id: 71, kind: "user", full_path: "acme-bot" });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    const grant = await client(request).exchangeCode({ code: "code-1", verifier: "verifier-1" });

    assert.equal(grant.user.namespaceId, 71);
    assert.equal(new Headers(calls[2]?.init?.headers).get("authorization"), "Bearer access");
  });

  it("refreshes with the refresh token grant and revokes through the client credentials", async () => {
    const { request, calls } = fakeFetch(({ url }) =>
      url.pathname === "/oauth/token"
        ? json({ access_token: "next", refresh_token: "next-refresh", expires_in: 7200 })
        : new Response(null, { status: 200 }),
    );
    const connection = client(request);

    const refreshed = await connection.refresh("old-refresh");
    await connection.revoke("next");

    assert.equal(form(calls[0]?.init).get("grant_type"), "refresh_token");
    assert.equal(form(calls[0]?.init).get("refresh_token"), "old-refresh");
    assert.deepEqual(refreshed, {
      accessToken: "next",
      refreshToken: "next-refresh",
      accessTokenExpiresAt: new Date("2026-09-17T12:00:00.000Z"),
    });
    assert.equal(calls[1]?.url.pathname, "/oauth/revoke");
    assert.equal(form(calls[1]?.init).get("token"), "next");
  });

  it("lists maintained groups across pages plus the personal namespace, sorted by path", async () => {
    const { request, calls } = fakeFetch(({ url }) => {
      assert.equal(url.pathname, "/api/v4/groups");
      assert.equal(url.searchParams.get("min_access_level"), "40");
      return url.searchParams.get("page") === "2"
        ? json([{ id: 3, full_path: "acme/security", name: "Security" }])
        : json(
            [
              { id: 1, full_path: "zeta", name: "Zeta" },
              { id: 2, full_path: "acme", name: "Acme" },
            ],
            {
              "x-next-page": "2",
            },
          );
    });

    const namespaces = await client(request).listNamespaces("access", {
      id: 7,
      username: "acme-bot",
      name: "Acme Bot",
      namespaceId: 70,
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(namespaces, [
      { id: 2, kind: "group", fullPath: "acme", name: "Acme" },
      { id: 70, kind: "user", fullPath: "acme-bot", name: "Acme Bot" },
      { id: 3, kind: "group", fullPath: "acme/security", name: "Security" },
      { id: 1, kind: "group", fullPath: "zeta", name: "Zeta" },
    ]);
  });

  it("lists a group's projects including subgroups, and only the user's own for a personal namespace", async () => {
    const { request, calls } = fakeFetch(({ url }) => {
      if (url.pathname === "/api/v4/groups/2/projects") {
        assert.equal(url.searchParams.get("include_subgroups"), "true");
        return json([
          {
            id: 20,
            path_with_namespace: "acme/web",
            default_branch: "main",
            web_url: "https://g/acme/web",
          },
          {
            id: 21,
            path_with_namespace: "acme/api",
            default_branch: null,
            web_url: "https://g/acme/api",
          },
        ]);
      }
      if (url.pathname === "/api/v4/users/7/projects") {
        return json([
          {
            id: 30,
            path_with_namespace: "acme-bot/notes",
            default_branch: "main",
            web_url: "https://g/acme-bot/notes",
            namespace: { id: 70 },
          },
          {
            id: 31,
            path_with_namespace: "acme/shared",
            default_branch: "main",
            web_url: "https://g/acme/shared",
            namespace: { id: 2 },
          },
        ]);
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const connection = client(request);

    const group = await connection.listProjects(
      "access",
      { id: 2, kind: "group", fullPath: "acme", name: "Acme" },
      7,
    );
    const personal = await connection.listProjects(
      "access",
      { id: 70, kind: "user", fullPath: "acme-bot", name: "Acme Bot" },
      7,
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(group, [
      {
        projectId: 21,
        pathWithNamespace: "acme/api",
        defaultBranch: null,
        webUrl: "https://g/acme/api",
      },
      {
        projectId: 20,
        pathWithNamespace: "acme/web",
        defaultBranch: "main",
        webUrl: "https://g/acme/web",
      },
    ]);
    assert.deepEqual(personal, [
      {
        projectId: 30,
        pathWithNamespace: "acme-bot/notes",
        defaultBranch: "main",
        webUrl: "https://g/acme-bot/notes",
      },
    ]);
  });

  it("normalizes the instance URL and refuses credentials or queries in it", () => {
    assert.equal(normalizeGitlabUrl("https://gitlab.com/"), "https://gitlab.com");
    assert.equal(
      normalizeGitlabUrl("https://git.example.test/gitlab/"),
      "https://git.example.test/gitlab",
    );
    assert.throws(() => normalizeGitlabUrl("https://user:secret@gitlab.com"));
    assert.throws(() => normalizeGitlabUrl("https://gitlab.com/?x=1"));
    assert.throws(() => normalizeGitlabUrl("ftp://gitlab.com"));
  });

  it("requires reauthorization without the api scope or a refreshable expired token", () => {
    const now = new Date("2026-09-17T10:00:00.000Z");
    const live = {
      scopes: ["api"],
      refreshToken: null,
      accessTokenExpiresAt: new Date("2026-09-17T11:00:00.000Z"),
    };
    assert.equal(gitlabConnectionRequiresReauthorization(live, now), false);
    assert.equal(
      gitlabConnectionRequiresReauthorization({ ...live, scopes: ["read_api"] }, now),
      true,
    );
    const expired = { ...live, accessTokenExpiresAt: new Date("2026-09-17T09:00:00.000Z") };
    assert.equal(gitlabConnectionRequiresReauthorization(expired, now), true);
    assert.equal(
      gitlabConnectionRequiresReauthorization({ ...expired, refreshToken: "r" }, now),
      false,
    );
  });
});

describe("GitLab API client", () => {
  it("refreshes an expired token once, persists it, and lists the namespace's projects with it", async () => {
    const connection: GitlabConnectionRecord = {
      id: "connection",
      organizationId: "org",
      slug: "acme-gitlab",
      providerApplicationId: "app-id",
      namespace: { id: 2, kind: "group", fullPath: "acme", name: "Acme" },
      user: { id: 7, username: "acme-bot", name: "Acme Bot" },
      accessToken: "expired",
      refreshToken: "refresh",
      accessTokenExpiresAt: new Date("2026-09-17T09:00:00.000Z"),
      scopes: ["api"],
    };
    let stored = connection;
    const refreshes: string[] = [];
    const listed: string[] = [];
    const api = createGitlabApiClient({
      url: "https://gitlab.example.test",
      connectionForNamespace: async () => stored,
      withGitlabConnectionRefresh: async (_namespaceId, operation) =>
        operation(stored, async (update) => {
          stored = { ...stored, ...update };
        }),
      connectionClient: {
        refresh: async (refreshToken) => {
          refreshes.push(refreshToken);
          return {
            accessToken: "fresh",
            refreshToken: "next-refresh",
            accessTokenExpiresAt: new Date("2026-09-17T12:00:00.000Z"),
          };
        },
        listProjects: async (accessToken) => {
          listed.push(accessToken);
          return [];
        },
      },
      now: () => new Date("2026-09-17T10:00:00.000Z"),
    });

    await api.listProjects(2);
    await api.listProjects(2);

    assert.deepEqual(refreshes, ["refresh"]);
    assert.deepEqual(listed, ["fresh", "fresh"]);
    assert.equal(stored.refreshToken, "next-refresh");
  });
});
