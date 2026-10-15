import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { handleConnections } from "../server/runtime.js";
import {
  CONNECTION_PROVIDERS,
  connectionProviderName,
  type ConnectionProvider,
} from "./result-contract.js";

export type { ConnectionProvider } from "./result-contract.js";

const scopeSchema = z.object({
  organizationSlug: z.string().min(1),
  projectSlug: z.string().min(1).optional(),
});
const githubStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.enum(["connected", "suspended"]),
  }),
]);
const discordStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const slackStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({
    status: z.literal("connected"),
  }),
]);
const linearStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notConfigured") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("requiresReauthorization") }),
  z.object({ status: z.literal("connected") }),
]);
export const connectionStatusSchema = z.object({
  canManage: z.boolean(),
  github: githubStatusSchema,
  discord: discordStatusSchema,
  slack: slackStatusSchema,
  linear: linearStatusSchema,
  gitlab: linearStatusSchema,
});
const gitlabNamespaceSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(["group", "user"]),
  fullPath: z.string().min(1),
  name: z.string().min(1),
});
const gitlabNamespacesSchema = z.object({ candidates: z.array(gitlabNamespaceSchema) });
const gitlabSelectionSchema = scopeSchema.extend({ attempt: z.string().min(1) });
const gitlabSelectSchema = gitlabSelectionSchema.extend({
  namespaceId: z.number().int().positive(),
});
const gitlabRefreshSchema = scopeSchema.extend({ connectionId: z.string().uuid() });

export type GitlabNamespaceCandidate = z.infer<typeof gitlabNamespaceSchema>;
const providerSchema = scopeSchema.extend({
  provider: z.enum(CONNECTION_PROVIDERS),
});
const disconnectSchema = providerSchema.extend({ connectionId: z.string().uuid() });
const startSchema = z.object({ url: z.string().url() });

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ConnectionDisconnectResult = `${ConnectionProvider}_disconnected`;

export const connectionStatus = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<ConnectionStatus>> => {
    try {
      const response = await handleConnections(
        operationRequest("GET", "/connections", data),
        "status",
      );
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.status",
          response,
          "Hub couldn't load this organization's connections. Reload the page.",
          data,
        );
      }
      return respondOk(connectionStatusSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.status", data), {
        fallback: "Hub couldn't load this organization's connections. Reload the page.",
      });
    }
  });

export const startConnection = createServerFn({ method: "POST" })
  .validator(providerSchema)
  .handler(async ({ data }): Promise<Result<{ url: string }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const operation = CONNECTION_OPERATIONS[data.provider].start;
      const response = await handleConnections(
        operationRequest("POST", "/connections/start", data),
        operation,
      );
      if (response.status === 403) {
        return connectionResponseFailure(
          "connection.start",
          response,
          `You don't have permission to start ${name}.`,
          data,
        );
      }
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.start",
          response,
          `Hub couldn't start the ${name} connection. Check the app status and provider availability before starting again.`,
          data,
        );
      }
      return respondOk(startSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.start", data), {
        fallback: `Hub couldn't start the ${name} connection. Check the app status and provider availability before starting again.`,
      });
    }
  });

export const disconnectConnection = createServerFn({ method: "POST" })
  .validator(disconnectSchema)
  .handler(async ({ data }): Promise<Result<{ result: ConnectionDisconnectResult }>> => {
    const name = connectionProviderName(data.provider);
    try {
      const operation = CONNECTION_OPERATIONS[data.provider].disconnect;
      const response = await handleConnections(
        operationRequest("POST", "/connections/disconnect", data, data.connectionId),
        operation,
      );
      if (response.status === 403) {
        return connectionResponseFailure(
          "connection.disconnect",
          response,
          `You don't have permission to disconnect ${name}.`,
          data,
        );
      }
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.disconnect",
          response,
          `Hub couldn't disconnect ${name}. Reload its connection status before disconnecting again.`,
          data,
        );
      }
      return respondOk({ result: `${data.provider}_disconnected` as const });
    } catch (error) {
      return respondWithFailure(error, connectionContext("connection.disconnect", data), {
        fallback: `Hub couldn't disconnect ${name}. Reload its connection status before disconnecting again.`,
      });
    }
  });

/**
 * GitLab authorizes a grant first and asks which namespace it covers second, so its connection
 * has three more operations than the others: the candidates, the choice, and the way out.
 */
export const gitlabNamespaces = createServerFn({ method: "POST" })
  .validator(gitlabSelectionSchema)
  .handler(async ({ data }): Promise<Result<{ candidates: GitlabNamespaceCandidate[] }>> => {
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/gitlab/namespaces", data, undefined, {
          state: data.attempt,
        }),
        "gitlabNamespaces",
      );
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.gitlab.namespaces",
          response,
          "Hub couldn't read your GitLab groups. Start the connection again from this page.",
          { ...data, provider: "gitlab" },
        );
      }
      return respondOk(gitlabNamespacesSchema.parse(await response.json()));
    } catch (error) {
      return respondWithFailure(
        error,
        connectionContext("connection.gitlab.namespaces", { ...data, provider: "gitlab" }),
        {
          fallback:
            "Hub couldn't read your GitLab groups. Start the connection again from this page.",
        },
      );
    }
  });

export const selectGitlabNamespace = createServerFn({ method: "POST" })
  .validator(gitlabSelectSchema)
  .handler(
    async ({
      data,
    }): Promise<Result<{ result: ConnectionDisconnectResult | "gitlab_connected" }>> => {
      try {
        const response = await handleConnections(
          operationRequest("POST", "/connections/gitlab/select", data, undefined, {
            state: data.attempt,
            namespaceId: String(data.namespaceId),
          }),
          "gitlabSelect",
        );
        if (!response.ok) {
          return connectionResponseFailure(
            "connection.gitlab.select",
            response,
            response.status === 409
              ? "That GitLab group is already connected to another organization. Nothing was connected."
              : "Hub couldn't connect that GitLab group. Start the connection again from this page.",
            { ...data, provider: "gitlab" },
          );
        }
        return respondOk({ result: "gitlab_connected" as const });
      } catch (error) {
        return respondWithFailure(
          error,
          connectionContext("connection.gitlab.select", { ...data, provider: "gitlab" }),
          {
            fallback:
              "Hub couldn't connect that GitLab group. Start the connection again from this page.",
          },
        );
      }
    },
  );

export const cancelGitlabConnection = createServerFn({ method: "POST" })
  .validator(gitlabSelectionSchema)
  .handler(async ({ data }): Promise<Result<{ result: "gitlab_cancelled" }>> => {
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/gitlab/cancel", data, undefined, {
          state: data.attempt,
        }),
        "gitlabCancel",
      );
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.gitlab.cancel",
          response,
          "Hub couldn't cancel the GitLab connection. Reload the page.",
          { ...data, provider: "gitlab" },
        );
      }
      return respondOk({ result: "gitlab_cancelled" as const });
    } catch (error) {
      return respondWithFailure(
        error,
        connectionContext("connection.gitlab.cancel", { ...data, provider: "gitlab" }),
        { fallback: "Hub couldn't cancel the GitLab connection. Reload the page." },
      );
    }
  });

export const refreshGitlabProjects = createServerFn({ method: "POST" })
  .validator(gitlabRefreshSchema)
  .handler(async ({ data }): Promise<Result<{ projects: number }>> => {
    try {
      const response = await handleConnections(
        operationRequest("POST", "/connections/gitlab/refresh", data, data.connectionId),
        "gitlabRefresh",
      );
      if (!response.ok) {
        return connectionResponseFailure(
          "connection.gitlab.refresh",
          response,
          "Hub couldn't read this group's projects from GitLab. Check the connection, then try again.",
          { ...data, provider: "gitlab" },
        );
      }
      return respondOk(z.object({ projects: z.number().int() }).parse(await response.json()));
    } catch (error) {
      return respondWithFailure(
        error,
        connectionContext("connection.gitlab.refresh", { ...data, provider: "gitlab" }),
        {
          fallback:
            "Hub couldn't read this group's projects from GitLab. Check the connection, then try again.",
        },
      );
    }
  });

const CONNECTION_OPERATIONS = {
  github: { start: "githubStart", disconnect: "githubDisconnect" },
  discord: { start: "discordStart", disconnect: "discordDisconnect" },
  slack: { start: "slackStart", disconnect: "slackDisconnect" },
  linear: { start: "linearStart", disconnect: "linearDisconnect" },
  gitlab: { start: "gitlabStart", disconnect: "gitlabDisconnect" },
} as const;

function connectionContext(
  operation: string,
  data: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider?: ConnectionProvider | undefined;
  },
) {
  return {
    operation,
    component: "connections",
    organizationSlug: data.organizationSlug,
    ...(data.projectSlug === undefined ? {} : { projectSlug: data.projectSlug }),
    ...(data.provider === undefined ? {} : { provider: data.provider }),
  } as const;
}

function connectionResponseFailure(
  operation: string,
  response: Response,
  message: string,
  data: {
    organizationSlug: string;
    projectSlug?: string | undefined;
    provider?: ConnectionProvider | undefined;
  },
) {
  return respondWithFailure(
    new Error(`connection operation returned HTTP ${response.status}`),
    { ...connectionContext(operation, data), status: response.status },
    {
      fallback: message,
      authentication: message,
      forbidden: message,
      notFound: message,
      conflict: message,
      validation: message,
    },
    { status: response.status },
  );
}

function operationRequest(
  method: "GET" | "POST",
  path: string,
  scope: { organizationSlug: string; projectSlug?: string | undefined },
  connectionId?: string,
  query: Readonly<Record<string, string>> = {},
): Request {
  const incoming = getRequest();
  const headers = new Headers(incoming.headers);
  headers.delete("content-length");
  const url = new URL(path, incoming.url);
  url.searchParams.set("organizationSlug", scope.organizationSlug);
  if (scope.projectSlug !== undefined) url.searchParams.set("projectSlug", scope.projectSlug);
  if (connectionId !== undefined) url.searchParams.set("connectionId", connectionId);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return new Request(url, {
    method,
    headers,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}
