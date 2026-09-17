import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import type { OrganizationAccessValue } from "../../auth/organization-access.js";
import type { AuthServer } from "../../auth/server.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type {
  BindGitlabConnectionInput,
  ConnectionAttemptRecord,
  GitlabConnectionRecord,
  StartConnectionAttemptInput,
} from "../../db/types.js";
import type { GitlabConnectionClient, GitlabGrant } from "./client.js";
import { createGitlabRegistration } from "./index.js";

const GRANT: GitlabGrant = {
  accessToken: "access",
  refreshToken: "refresh",
  accessTokenExpiresAt: new Date("2026-09-17T12:00:00.000Z"),
  scopes: ["api"],
  user: { id: 7, username: "acme-bot", name: "Acme Bot", namespaceId: 70 },
};
const NAMESPACES = [
  { id: 42, kind: "group" as const, fullPath: "acme", name: "Acme" },
  { id: 70, kind: "user" as const, fullPath: "acme-bot", name: "Acme Bot" },
];
const PROJECTS = [
  {
    projectId: 4201,
    pathWithNamespace: "acme/web",
    defaultBranch: "main",
    webUrl: "https://g/acme/web",
  },
];
const EMPTY_USAGE = { github: [], discord: [], slack: [], linear: [], gitlab: [] };

describe("GitLab registration", () => {
  it("is a connection-only slice that starts OAuth with PKCE over any origin", async () => {
    const database = memberDatabase();
    let attempt: StartConnectionAttemptInput | undefined;
    database.startConnectionAttempt = (input) => {
      attempt = input;
      return Promise.resolve();
    };
    const client = new GitlabConnectionFake();
    const registration = createGitlabRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "http://hub.test",
      publicBaseUrl: "http://hub.test",
      configuration: gitlabConfiguration(),
      connectionClient: client,
    });

    assert.equal(registration.connection.name, "gitlab");
    assert.deepEqual(registration.sources, []);
    assert.deepEqual(registration.triggerProviders, []);
    assert.deepEqual(registration.outputs, []);
    assert.deepEqual(registration.requests, []);

    const response = await registration.connection.actions["start"]!(
      new Request("http://hub.test/start?organizationSlug=org", { method: "POST" }),
    );
    assert.equal(response.status, 200);
    assert.equal(attempt?.provider, "gitlab");
    assert.equal(attempt?.providerApplicationId, "app-id");
    assert.deepEqual(attempt?.configurationSnapshot, {
      provider: "gitlab",
      ...gitlabConfiguration(),
    });
    const body = z.object({ url: z.string() }).parse(await response.json());
    const url = new URL(body.url);
    const state = url.searchParams.get("state");
    assert(state !== null && state.length > 20);
    assert.equal(attempt?.stateVerifier, sha256(state, "hex"));
    assert(attempt?.pkceVerifier !== undefined && attempt.pkceVerifier.length > 20);
    assert.equal(url.searchParams.get("challenge"), sha256(attempt.pkceVerifier, "base64url"));
  });

  it("does not construct partial behavior when GitLab is not configured", async () => {
    const registration = createGitlabRegistration({
      database: createMemoryDatabase(),
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: null,
    });

    assert.deepEqual(registration.connection.status(EMPTY_USAGE), { status: "notConfigured" });
    const response = await registration.connection.actions["namespaces"]!(
      new Request("https://hub.test/connections/gitlab/namespaces?state=x", { method: "POST" }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "provider_not_configured" });
  });

  it("reports reauthorization for a grant without api or an expired token it cannot refresh", () => {
    const registration = createGitlabRegistration({
      database: createMemoryDatabase(),
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: gitlabConfiguration(),
    });
    const status = (connection: Partial<GitlabConnectionRecord>) =>
      registration.connection.status({ ...EMPTY_USAGE, gitlab: [gitlabConnection(connection)] });

    assert.deepEqual(registration.connection.status(EMPTY_USAGE), { status: "disconnected" });
    assert.deepEqual(status({ scopes: ["read_api"] }), { status: "requiresReauthorization" });
    assert.deepEqual(status({ refreshToken: null, accessTokenExpiresAt: new Date(0) }), {
      status: "requiresReauthorization",
    });
    assert.deepEqual(status({ refreshToken: "refresh", accessTokenExpiresAt: new Date(0) }), {
      status: "connected",
    });
  });

  it("turns the callback code into a grant parked on the attempt under a fresh state", async () => {
    const database = memberDatabase();
    database.readConnectionAttempt = async (input) => {
      assert.equal(input.phase, "gitlab_authorization");
      assert.equal(input.stateVerifier, sha256("state-1", "hex"));
      return attemptRecord({ phase: "gitlab_authorization", pkceVerifier: "verifier-1" });
    };
    const advanced: unknown[] = [];
    database.advanceGitlabConnectionAttempt = async (input) => {
      advanced.push(input);
    };
    const client = new GitlabConnectionFake();
    const registration = createGitlabRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: gitlabConfiguration(),
      connectionClient: client,
    });

    const response = await registration.connection.actions["callback"]!(
      new Request("https://hub.test/api/integrations/gitlab/callback?state=state-1&code=code-1"),
    );

    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, "https://hub.test/apps");
    assert.equal(location.searchParams.get("app"), "gitlab");
    assert.equal(location.searchParams.get("result"), "gitlab_namespace_required");
    const next = location.searchParams.get("attempt");
    assert(next !== null && next.length > 20);
    assert.deepEqual(client.exchanged, [{ code: "code-1", verifier: "verifier-1" }]);
    assert.deepEqual(advanced, [
      {
        stateVerifier: sha256("state-1", "hex"),
        phase: "gitlab_authorization",
        access: { sessionId: "session", userId: "user" },
        nextStateVerifier: sha256(next, "hex"),
        grant: GRANT,
      },
    ]);
  });

  it("lists the grant's namespaces, binds the chosen one with its projects, and refuses others", async () => {
    const database = memberDatabase();
    database.readConnectionAttempt = async (input) => {
      assert.equal(input.phase, "gitlab_namespace_selection");
      return attemptRecord({ phase: "gitlab_namespace_selection", candidateGrant: GRANT });
    };
    const bound: BindGitlabConnectionInput[] = [];
    database.bindGitlabConnection = async (input) => {
      bound.push(input);
    };
    const registration = createGitlabRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: gitlabConfiguration(),
      connectionClient: new GitlabConnectionFake(),
    });

    const listed = await registration.connection.actions["namespaces"]!(
      new Request("https://hub.test/connections/gitlab/namespaces?state=state-2", {
        method: "POST",
      }),
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { candidates: NAMESPACES });

    const refused = await registration.connection.actions["select"]!(
      new Request("https://hub.test/connections/gitlab/select?state=state-2&namespaceId=999", {
        method: "POST",
      }),
    );
    assert.equal(refused.status, 400);
    assert.deepEqual(bound, []);

    const selected = await registration.connection.actions["select"]!(
      new Request("https://hub.test/connections/gitlab/select?state=state-2&namespaceId=42", {
        method: "POST",
      }),
    );
    assert.equal(selected.status, 200);
    assert.deepEqual(await selected.json(), { result: "gitlab_connected" });
    assert.deepEqual(bound, [
      {
        stateVerifier: sha256("state-2", "hex"),
        phase: "gitlab_namespace_selection",
        access: { sessionId: "session", userId: "user" },
        providerApplicationId: "app-id",
        namespace: NAMESPACES[0],
        user: { id: 7, username: "acme-bot", name: "Acme Bot" },
        accessToken: "access",
        refreshToken: "refresh",
        accessTokenExpiresAt: GRANT.accessTokenExpiresAt,
        scopes: ["api"],
        projects: PROJECTS,
      },
    ]);
  });

  it("hands an activating attempt to the installation handler instead of binding directly", async () => {
    const database = memberDatabase();
    database.readConnectionAttempt = async () =>
      attemptRecord({
        phase: "gitlab_namespace_selection",
        candidateGrant: GRANT,
        activateConfiguration: true,
        expectedConfigurationVersion: 2,
      });
    database.bindGitlabConnection = async () => {
      throw new Error("must not bind directly");
    };
    const handled: unknown[] = [];
    const registration = createGitlabRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: gitlabConfiguration(),
      connectionClient: new GitlabConnectionFake(),
      activateConfiguration: true,
      onVerifiedInstallation: async (input) => {
        handled.push(input);
      },
    });

    const selected = await registration.connection.actions["select"]!(
      new Request("https://hub.test/connections/gitlab/select?state=state-3&namespaceId=70", {
        method: "POST",
      }),
    );

    assert.equal(selected.status, 200);
    assert.equal(handled.length, 1);
    const input = z
      .object({
        expectedConfigurationVersion: z.number(),
        callbackOrigin: z.string(),
        userId: z.string(),
        binding: z.object({ namespace: z.object({ id: z.number() }) }),
      })
      .parse(handled[0]);
    assert.equal(input.expectedConfigurationVersion, 2);
    assert.equal(input.callbackOrigin, "https://hub.test");
    assert.equal(input.userId, "user");
    assert.equal(input.binding.namespace.id, 70);
  });

  it("cancelling the choice consumes the attempt and revokes the parked grant", async () => {
    const database = memberDatabase();
    database.readConnectionAttempt = async () =>
      attemptRecord({ phase: "gitlab_namespace_selection", candidateGrant: GRANT });
    const consumed: string[] = [];
    database.consumeConnectionAttempt = async (input) => {
      consumed.push(input.phase);
    };
    const client = new GitlabConnectionFake();
    const registration = createGitlabRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: gitlabConfiguration(),
      connectionClient: client,
    });

    const response = await registration.connection.actions["cancel"]!(
      new Request("https://hub.test/connections/gitlab/cancel?state=state-4", { method: "POST" }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: "gitlab_cancelled" });
    assert.deepEqual(consumed, ["gitlab_namespace_selection"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(client.revoked, ["access"]);
  });

  it("re-reads a connection's projects on request through the refreshing API client", async () => {
    const database = memberDatabase();
    database.findGitlabConnectionForOrganization = async (organizationId, connectionId) =>
      organizationId === "org" && connectionId === "11111111-1111-4111-8111-111111111111"
        ? gitlabConnection({ id: connectionId })
        : undefined;
    const replaced: unknown[] = [];
    database.replaceGitlabProjects = async (organizationId, connectionId, projects) => {
      replaced.push({ organizationId, connectionId, projects });
    };
    const registration = createGitlabRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: gitlabConfiguration(),
      connectionClient: new GitlabConnectionFake(),
      apiClient: { listProjects: async () => PROJECTS },
    });

    const response = await registration.connection.actions["refresh"]!(
      new Request(
        "https://hub.test/connections/gitlab/refresh?organizationSlug=org&connectionId=11111111-1111-4111-8111-111111111111",
        { method: "POST" },
      ),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { projects: 1 });
    assert.deepEqual(replaced, [
      {
        organizationId: "org",
        connectionId: "11111111-1111-4111-8111-111111111111",
        projects: PROJECTS,
      },
    ]);
  });
});

function gitlabConfiguration() {
  return { url: "https://gitlab.example.test", clientId: "app-id", clientSecret: "app-secret" };
}

function sha256(value: string, encoding: "hex" | "base64url"): string {
  return createHash("sha256").update(value).digest(encoding);
}

function memberDatabase() {
  return createMemoryDatabase({
    memberships: [
      {
        userId: "user",
        organizationId: "org",
        organizationName: "Org",
        organizationSlug: "org",
        membershipId: "membership",
        role: "owner",
      },
    ],
  });
}

function attemptRecord(overrides: Partial<ConnectionAttemptRecord>): ConnectionAttemptRecord {
  return {
    id: "attempt",
    provider: "gitlab",
    phase: "gitlab_authorization",
    organizationId: "org",
    returnRoute: "/apps",
    userId: "user",
    sessionId: "session",
    candidateExternalId: null,
    pkceVerifier: null,
    candidateGrant: null,
    configurationVersion: 1,
    providerApplicationId: "app-id",
    callbackOrigin: "https://hub.test",
    configurationSnapshot: { provider: "gitlab", ...gitlabConfiguration() },
    expectedConfigurationVersion: null,
    activateConfiguration: false,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    consumedAt: null,
    ...overrides,
  };
}

function gitlabConnection(overrides: Partial<GitlabConnectionRecord>): GitlabConnectionRecord {
  return {
    id: "gitlab-connection",
    organizationId: "org",
    slug: "acme-gitlab",
    providerApplicationId: "app-id",
    namespace: NAMESPACES[0]!,
    user: { id: 7, username: "acme-bot", name: "Acme Bot" },
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    scopes: ["api"],
    ...overrides,
  };
}

class GitlabConnectionFake implements GitlabConnectionClient {
  readonly exchanged: { code: string; verifier: string }[] = [];
  readonly revoked: string[] = [];

  authorizationUrl({ state, challenge }: { state: string; challenge: string }): string {
    return `https://gitlab.example.test/oauth/authorize?state=${state}&challenge=${challenge}`;
  }

  exchangeCode(input: { code: string; verifier: string }): Promise<GitlabGrant> {
    this.exchanged.push(input);
    return Promise.resolve(GRANT);
  }

  refresh(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  revoke(accessToken: string): Promise<void> {
    this.revoked.push(accessToken);
    return Promise.resolve();
  }

  listNamespaces() {
    return Promise.resolve([...NAMESPACES]);
  }

  listProjects(_token: string, namespace: { id: number }) {
    return Promise.resolve(namespace.id === 42 ? [...PROJECTS] : []);
  }
}

class RegistrationAuth implements AuthServer {
  handle(): Promise<Response> {
    return Promise.resolve(new Response());
  }

  resources(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  resolveOrganizationAccess(): Promise<OrganizationAccessValue> {
    return Promise.resolve({
      session: { id: "session" },
      account: { id: "user", name: "User", email: "user@example.test" },
      organization: { id: "org", name: "Org" },
      membership: { id: "membership", role: "owner" },
      capabilities: { view: true, manageMembers: true, manageOwners: true, manageResources: true },
    });
  }

  async resolveAccount() {
    const access = await this.resolveOrganizationAccess();
    return {
      session: { id: access.session.id, activeOrganizationId: null },
      account: access.account,
      isInstanceOperator: false,
    };
  }

  rejectCookieMutation(): Response | undefined {
    return undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
