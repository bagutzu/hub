import { createHash } from "node:crypto";
import type { AuthServer } from "../../auth/server.js";
import {
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
  CONNECTIONS_RETURN_ROUTE,
  callbackConnectionAccess,
  cancelledConnectionResult,
  connectionAccess,
  connectionActionFailure,
  connectionCallbackFailure,
  manageConnectionAccess,
  newConnectionState,
  requiredConnectionId,
  stateHash,
} from "../../connections/shared.js";
import { connectionReturnUrl } from "../../connections/result-contract.js";
import { ConnectionAccessDeniedError } from "../../db/errors.js";
import type {
  BindGitlabConnectionInput,
  ConnectionAttemptRecord,
  Database,
  GitlabConnectionRecord,
} from "../../db/types.js";
import { logger } from "../../logger.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import {
  GitlabGrantSchema,
  createGitlabApiClient,
  createGitlabConnectionClient,
  gitlabConnectionRequiresReauthorization,
  type GitlabApiClient,
  type GitlabConnectionClient,
  type GitlabGrant,
} from "./client.js";

export interface GitlabRegistrationConfiguration {
  url: string;
  clientId: string;
  clientSecret: string;
}

export type GitlabInstallationHandler = (input: {
  configuration: unknown;
  expectedConfigurationVersion: number | undefined;
  callbackOrigin: string;
  userId: string;
  binding: BindGitlabConnectionInput;
}) => Promise<void>;

export interface CreateGitlabRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  configuration?: GitlabRegistrationConfiguration | null;
  connectionClient?: GitlabConnectionClient;
  apiClient?: GitlabApiClient;
  fetch?: typeof fetch;
  configurationVersion?: number;
  expectedConfigurationVersion?: number;
  activateConfiguration?: boolean;
  onVerifiedInstallation?: GitlabInstallationHandler;
}

interface GitlabConnectionOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  callbackOrigin: string;
  configurationVersion: number;
  configuration: GitlabRegistrationConfiguration;
  expectedConfigurationVersion: number | undefined;
  activateConfiguration: boolean;
  onVerifiedInstallation: GitlabInstallationHandler | undefined;
}

export function createGitlabRegistration(
  options: CreateGitlabRegistrationOptions,
): ProviderRegistration {
  const configuration = options.configuration ?? null;
  if (configuration === null || options.publicBaseUrl === undefined) {
    return emptyGitlabRegistration(options);
  }
  const connectionClient =
    options.connectionClient ??
    createGitlabConnectionClient({
      url: configuration.url,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      publicBaseUrl: options.publicBaseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const database = options.database;
  if (database === null) {
    return {
      connection: gitlabConnectionStatus(true),
      triggerProviders: [],
      sources: [],
      outputs: [],
      requests: [],
    };
  }
  const api =
    options.apiClient ??
    createGitlabApiClient({
      url: configuration.url,
      connectionForNamespace: (namespaceId) => database.findGitlabConnection(namespaceId),
      withGitlabConnectionRefresh: database.withGitlabConnectionRefresh.bind(database),
      connectionClient,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const connection =
    options.auth === null
      ? gitlabConnectionStatus(true)
      : createGitlabConnection(
          {
            database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
            callbackOrigin: options.publicBaseUrl,
            configurationVersion: options.configurationVersion ?? 0,
            configuration,
            expectedConfigurationVersion: options.expectedConfigurationVersion,
            activateConfiguration: options.activateConfiguration ?? false,
            onVerifiedInstallation: options.onVerifiedInstallation,
          },
          connectionClient,
          api,
        );
  return {
    configurationSnapshot: {
      version: options.configurationVersion ?? 0,
      callbackOrigin: options.publicBaseUrl,
    },
    connection,
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function emptyGitlabRegistration(
  options: Pick<CreateGitlabRegistrationOptions, "database" | "auth" | "applicationBaseUrl">,
): ProviderRegistration {
  const connection =
    options.database === null || options.auth === null
      ? gitlabConnectionStatus(false)
      : createGitlabConnection(
          {
            database: options.database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
            callbackOrigin: options.applicationBaseUrl,
            configurationVersion: 0,
            configuration: {
              url: "unconfigured",
              clientId: "unconfigured",
              clientSecret: "unconfigured",
            },
            expectedConfigurationVersion: undefined,
            activateConfiguration: false,
            onVerifiedInstallation: undefined,
          },
          undefined,
          undefined,
        );
  return { connection, triggerProviders: [], sources: [], outputs: [], requests: [] };
}

function gitlabConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "gitlab",
    status: (connections) => gitlabStatus(configured, connections.gitlab),
    actions: {},
  };
}

function createGitlabConnection(
  options: GitlabConnectionOptions,
  client: GitlabConnectionClient | undefined,
  api: GitlabApiClient | undefined,
): ProviderConnectionRegistration {
  const start = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      if (client === undefined)
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      const state = newConnectionState();
      const verifier = newConnectionState();
      await options.database.startConnectionAttempt({
        provider: "gitlab",
        stateVerifier: stateHash(state),
        pkceVerifier: verifier,
        access: connectionAccess(access),
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
        callbackOrigin: options.callbackOrigin,
        configurationVersion: options.configurationVersion,
        providerApplicationId: options.configuration.clientId,
        configurationSnapshot: { provider: "gitlab", ...options.configuration },
        expectedConfigurationVersion: options.expectedConfigurationVersion ?? null,
        activateConfiguration: options.activateConfiguration,
      });
      return Response.json({
        url: client.authorizationUrl({ state, challenge: pkceChallenge(verifier) }),
      });
    } catch (error) {
      return connectionActionFailure(error, "gitlab", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const disconnected = await options.database.disconnectConnection(
        "gitlab",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      if (disconnected.provider === "gitlab" && disconnected.accessToken !== undefined) {
        revokeQuietly(client, disconnected.accessToken);
      }
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "gitlab", "disconnect");
    }
  };

  /** The namespaces the pending grant may cover, for the picker the callback sent the browser to. */
  const namespaces = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      if (client === undefined)
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      const { grant } = await pendingSelection(options, request);
      return Response.json({
        candidates: await client.listNamespaces(grant.accessToken, grant.user),
      });
    } catch (error) {
      return connectionActionFailure(error, "gitlab", "namespaces");
    }
  };

  const select = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      if (client === undefined)
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      const { state, access, attempt, grant } = await pendingSelection(options, request);
      const namespaceId = Number(new URL(request.url).searchParams.get("namespaceId"));
      const namespace = (await client.listNamespaces(grant.accessToken, grant.user)).find(
        (candidate) => candidate.id === namespaceId,
      );
      if (namespace === undefined) {
        return Response.json({ error: "invalid_namespace" }, { status: 400 });
      }
      const binding: BindGitlabConnectionInput = {
        stateVerifier: stateHash(state),
        phase: "gitlab_namespace_selection",
        access,
        providerApplicationId: options.configuration.clientId,
        namespace,
        user: { id: grant.user.id, username: grant.user.username, name: grant.user.name },
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        accessTokenExpiresAt: grant.accessTokenExpiresAt,
        scopes: grant.scopes,
        projects: await client.listProjects(grant.accessToken, namespace, grant.user.id),
      };
      if (attempt.activateConfiguration) {
        if (options.onVerifiedInstallation === undefined) {
          throw new Error("GitLab installation handler unavailable");
        }
        await options.onVerifiedInstallation({
          configuration: attempt.configurationSnapshot,
          expectedConfigurationVersion: attempt.expectedConfigurationVersion ?? undefined,
          callbackOrigin: attempt.callbackOrigin,
          userId: attempt.userId,
          binding,
        });
      } else {
        await options.database.bindGitlabConnection(binding);
      }
      return Response.json({ result: "gitlab_connected" });
    } catch (error) {
      return connectionActionFailure(error, "gitlab", "select");
    }
  };

  const cancel = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const { state, access, grant } = await pendingSelection(options, request);
      await options.database.consumeConnectionAttempt({
        stateVerifier: stateHash(state),
        phase: "gitlab_namespace_selection",
        access,
      });
      revokeQuietly(client, grant.accessToken);
      return Response.json({ result: "gitlab_cancelled" });
    } catch (error) {
      return connectionActionFailure(error, "gitlab", "cancel");
    }
  };

  /** GitLab sends no installation events, so the project list is re-read on request. */
  const refresh = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      if (api === undefined)
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      const connection = await options.database.findGitlabConnectionForOrganization(
        access.tenant.organization.id,
        requiredConnectionId(request),
      );
      if (connection === undefined) throw new ConnectionAccessDeniedError();
      const projects = await api.listProjects(connection.namespace.id);
      await options.database.replaceGitlabProjects(
        connection.organizationId,
        connection.id,
        projects,
      );
      return Response.json({ projects: projects.length });
    } catch (error) {
      return connectionActionFailure(error, "gitlab", "refresh");
    }
  };

  return {
    name: "gitlab",
    status: (connections) => gitlabStatus(client !== undefined, connections.gitlab),
    actions: {
      start,
      disconnect,
      callback: (request) => completeAuthorization(options, client, request),
      namespaces,
      select,
      cancel,
      refresh,
    },
  };
}

/**
 * The first leg is done when GitLab sends the browser back: the code becomes a grant, and the
 * grant waits on the attempt for the namespace choice under a fresh state.
 */
async function completeAuthorization(
  options: GitlabConnectionOptions,
  client: GitlabConnectionClient | undefined,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state !== null && code === null && url.searchParams.get("error") === "access_denied") {
    return cancelledConnectionResult({
      auth: options.auth,
      database: options.database,
      request,
      provider: "gitlab",
      phase: "gitlab_authorization",
      state,
      applicationBaseUrl: options.applicationBaseUrl,
    });
  }
  if (state === null || code === null || client === undefined) {
    return connectionCallbackFailure({
      request,
      error: new GitlabCallbackError(),
      provider: "gitlab",
      phase: "authorization",
      applicationBaseUrl: options.applicationBaseUrl,
      returnRoute: CONNECTIONS_RETURN_ROUTE,
    });
  }
  let returnRoute: string = CONNECTIONS_RETURN_ROUTE;
  let callbackOrigin = options.applicationBaseUrl;
  try {
    const access = await callbackConnectionAccess(options.auth, request);
    const attempt = await options.database.readConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "gitlab_authorization",
      access,
    });
    returnRoute = attempt.returnRoute;
    callbackOrigin = attempt.callbackOrigin;
    if (attempt.pkceVerifier === null) throw new GitlabCallbackError();
    const grant = await client.exchangeCode({ code, verifier: attempt.pkceVerifier });
    const nextState = newConnectionState();
    await options.database.advanceGitlabConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "gitlab_authorization",
      access,
      nextStateVerifier: stateHash(nextState),
      grant,
    });
    return Response.redirect(
      connectionReturnUrl(callbackOrigin, returnRoute, {
        provider: "gitlab",
        result: "gitlab_namespace_required",
        attempt: nextState,
      }),
      303,
    );
  } catch (error) {
    return connectionCallbackFailure({
      request,
      error,
      provider: "gitlab",
      phase: "authorization",
      applicationBaseUrl: callbackOrigin,
      returnRoute,
    });
  }
}

async function pendingSelection(
  options: GitlabConnectionOptions,
  request: Request,
): Promise<{
  state: string;
  access: Awaited<ReturnType<typeof callbackConnectionAccess>>;
  attempt: ConnectionAttemptRecord;
  grant: GitlabGrant;
}> {
  const state = new URL(request.url).searchParams.get("state");
  if (state === null) throw new ConnectionAccessDeniedError();
  const access = await callbackConnectionAccess(options.auth, request);
  const attempt = await options.database.readConnectionAttempt({
    stateVerifier: stateHash(state),
    phase: "gitlab_namespace_selection",
    access,
  });
  return { state, access, attempt, grant: GitlabGrantSchema.parse(attempt.candidateGrant) };
}

function revokeQuietly(client: GitlabConnectionClient | undefined, accessToken: string): void {
  void client?.revoke(accessToken).catch((error: unknown) => {
    logger.warn({ err: error, provider: "gitlab" }, "provider cleanup failed after disconnect");
  });
}

class GitlabCallbackError extends Error {
  readonly code = "invalidInput";
  constructor() {
    super("invalid GitLab callback");
  }
}

function gitlabStatus(configured: boolean, bindings: readonly GitlabConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  if (bindings.length === 0) return { status: "disconnected" as const };
  return bindings.some((binding) => gitlabConnectionRequiresReauthorization(binding))
    ? { status: "requiresReauthorization" as const }
    : { status: "connected" as const };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
