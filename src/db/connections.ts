import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Locks } from "./runtime/locks/index.js";
import type { DatabaseRuntime, DrizzleHandle, TransactionHandle } from "./runtime/index.js";
import { slugify } from "../slug.js";
import {
  ConnectionAccessDeniedError,
  ConnectionAttemptUnavailableError,
  ConnectionConflictError,
} from "./errors.js";
import * as schema from "./schema.js";
import type {
  AdvanceGitHubConnectionAttemptInput,
  AdvanceGitlabConnectionAttemptInput,
  BindDiscordConnectionInput,
  BindGitHubConnectionInput,
  BindGitlabConnectionInput,
  BindLinearConnectionInput,
  BindSlackConnectionInput,
  CompleteGitlabProviderApplicationInput,
  CompleteLinearProviderApplicationInput,
  CompleteSlackProviderApplicationInput,
  ConnectionAccountAccess,
  ConnectionAttemptPhase,
  ConnectionAttemptRecord,
  ConnectionProvider,
  ConnectionStartAuthority,
  DiscordConnectionRecord,
  GitHubConnectionRecord,
  GitlabConnectionRecord,
  GitlabConnectionRefreshOperation,
  GitlabProjectInput,
  GitlabProjectRecord,
  LinearConnectionRecord,
  LinearConnectionRefreshOperation,
  ReadConnectionAttemptInput,
  SlackConnectionRecord,
  StartConnectionAttemptInput,
  UpdateLinearConnectionTokensInput,
} from "./types.js";

type HubDatabase = DrizzleHandle;
type HubTransaction = HubDatabase;
type AttemptRow = typeof schema.organizationConnectionAttempts.$inferSelect;

export class ConnectionRepository {
  private readonly database: HubDatabase;

  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
  ) {
    this.database = runtime.drizzle();
  }

  async startAttempt(input: StartConnectionAttemptInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, input.access);
      await transaction.delete(schema.organizationConnectionAttempts).where(orExpiredOrConsumed());
      await transaction.insert(schema.organizationConnectionAttempts).values({
        provider: input.provider,
        phase: initialConnectionAttemptPhase(input.provider),
        stateVerifier: input.stateVerifier,
        organizationId: input.access.organizationId,
        returnRoute: input.access.returnRoute,
        userId: input.access.userId,
        sessionId: input.access.sessionId,
        pkceVerifier: input.pkceVerifier ?? null,
        configurationVersion: input.configurationVersion,
        providerApplicationId: input.providerApplicationId,
        callbackOrigin: input.callbackOrigin,
        configurationSnapshot: input.configurationSnapshot,
        expectedConfigurationVersion: input.expectedConfigurationVersion,
        activateConfiguration: input.activateConfiguration,
        expiresAt: sql`clock_timestamp() + (${input.lifetimeMinutes} * interval '1 minute')`,
      });
    });
  }

  async readAttempt(input: ReadConnectionAttemptInput): Promise<ConnectionAttemptRecord> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      return toAttempt(attempt);
    });
  }

  async findAttemptConfiguration(stateVerifier: string): Promise<
    | {
        configurationVersion: number;
        callbackOrigin: string;
        configurationSnapshot: unknown;
        expectedConfigurationVersion: number | null;
        activateConfiguration: boolean;
      }
    | undefined
  > {
    const [attempt] = await this.database
      .select({
        configurationVersion: schema.organizationConnectionAttempts.configurationVersion,
        callbackOrigin: schema.organizationConnectionAttempts.callbackOrigin,
        configurationSnapshot: schema.organizationConnectionAttempts.configurationSnapshot,
        expectedConfigurationVersion:
          schema.organizationConnectionAttempts.expectedConfigurationVersion,
        activateConfiguration: schema.organizationConnectionAttempts.activateConfiguration,
      })
      .from(schema.organizationConnectionAttempts)
      .where(
        and(
          eq(schema.organizationConnectionAttempts.stateVerifier, stateVerifier),
          isNull(schema.organizationConnectionAttempts.consumedAt),
        ),
      )
      .limit(1);
    return attempt;
  }

  async consumeAttempt(input: ReadConnectionAttemptInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, attempt.provider);
      await requireConsumableAttempt(transaction, attempt);
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async advanceGitHubAttempt(input: AdvanceGitHubConnectionAttemptInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, attempt.provider);
      await requireCurrentAttempt(transaction, attempt);
      await transaction
        .update(schema.organizationConnectionAttempts)
        .set({
          phase: "github_user_authorization",
          stateVerifier: input.nextStateVerifier,
          candidateExternalId: String(input.installationId),
          pkceVerifier: input.pkceVerifier,
        })
        .where(eq(schema.organizationConnectionAttempts.id, attempt.id));
    });
  }

  async bindGitHub(input: BindGitHubConnectionInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, "github");
      await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      await lockExternal(this.locks, runtimeTransaction, "github", String(input.installationId));
      const [existing] = await transaction
        .select({
          id: schema.githubConnections.id,
          organizationId: schema.githubConnections.organizationId,
          slug: schema.githubConnections.slug,
        })
        .from(schema.githubConnections)
        .where(eq(schema.githubConnections.installationId, input.installationId))
        .for("update");
      if (existing !== undefined && existing.organizationId !== attempt.organizationId)
        throw new ConnectionConflictError();
      const [_connection] =
        existing === undefined
          ? await transaction
              .insert(schema.githubConnections)
              .values({
                organizationId: attempt.organizationId,
                installationId: input.installationId,
                providerApplicationId: input.providerApplicationId,
                slug: await uniqueConnectionSlug(
                  transaction,
                  attempt.organizationId,
                  "github",
                  input.accountLogin,
                ),
                accountId: input.accountId,
                accountLogin: input.accountLogin,
                accountType: input.accountType,
                status: input.status,
                connectedByUserId: attempt.userId,
                suspendedAt: input.status === "suspended" ? sql`clock_timestamp()` : null,
              })
              .returning({ id: schema.githubConnections.id })
          : await transaction
              .update(schema.githubConnections)
              .set({
                accountId: input.accountId,
                accountLogin: input.accountLogin,
                accountType: input.accountType,
                status: input.status,
                suspendedAt: input.status === "suspended" ? sql`clock_timestamp()` : null,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(schema.githubConnections.id, existing.id))
              .returning({ id: schema.githubConnections.id });
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async bindDiscord(input: BindDiscordConnectionInput): Promise<void> {
    await this.bindExclusive(input, "discord", input.guildId, async (transaction, attempt) => {
      const [_connection] = await transaction
        .insert(schema.discordConnections)
        .values({
          organizationId: attempt.organizationId,
          guildId: input.guildId,
          providerApplicationId: input.providerApplicationId,
          guildName: input.guildName,
          slug: await uniqueConnectionSlug(
            transaction,
            attempt.organizationId,
            "discord",
            input.guildName,
          ),
          connectedByUserId: attempt.userId,
        })
        .returning({ id: schema.discordConnections.id });
    });
  }

  async bindSlack(input: BindSlackConnectionInput): Promise<void> {
    await this.bindSlackTransition(input);
  }

  async completeSlackProviderApplication(
    input: CompleteSlackProviderApplicationInput,
  ): Promise<void> {
    await this.bindSlackTransition(input, input.providerConfiguration);
  }

  private async bindSlackTransition(
    input: BindSlackConnectionInput,
    providerConfiguration?: CompleteSlackProviderApplicationInput["providerConfiguration"],
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, "slack");
      if (providerConfiguration === undefined) {
        await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      } else {
        await requireActivationCandidate(
          transaction,
          attempt,
          input.providerApplicationId,
          providerConfiguration,
          () =>
            transaction
              .select({ applicationId: schema.slackConnections.providerApplicationId })
              .from(schema.slackConnections)
              .for("update"),
        );
      }
      await lockExternal(this.locks, runtimeTransaction, "slack", input.teamId);
      const [existing] = await transaction
        .select({
          id: schema.slackConnections.id,
          organizationId: schema.slackConnections.organizationId,
        })
        .from(schema.slackConnections)
        .where(eq(schema.slackConnections.teamId, input.teamId))
        .for("update");
      if (existing !== undefined && existing.organizationId !== attempt.organizationId) {
        throw new ConnectionConflictError();
      }
      if (existing === undefined) {
        await transaction.insert(schema.slackConnections).values({
          organizationId: attempt.organizationId,
          teamId: input.teamId,
          providerApplicationId: input.providerApplicationId,
          teamName: input.teamName,
          slug: await uniqueConnectionSlug(
            transaction,
            attempt.organizationId,
            "slack",
            input.teamName,
          ),
          botUserId: input.botUserId,
          botAccessToken: input.botAccessToken,
          scopes: input.scopes,
          connectedByUserId: attempt.userId,
        });
      } else {
        await transaction
          .update(schema.slackConnections)
          .set({
            teamName: input.teamName,
            providerApplicationId: input.providerApplicationId,
            botUserId: input.botUserId,
            botAccessToken: input.botAccessToken,
            scopes: input.scopes,
            connectedByUserId: attempt.userId,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.slackConnections.id, existing.id));
      }
      if (providerConfiguration !== undefined) {
        await persistProviderConfiguration(
          transaction,
          "slack",
          providerConfiguration,
          input.providerApplicationId,
          attempt.configurationVersion,
        );
      }
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async bindLinear(input: BindLinearConnectionInput): Promise<void> {
    await this.bindLinearTransition(input);
  }

  async completeLinearProviderApplication(
    input: CompleteLinearProviderApplicationInput,
  ): Promise<void> {
    await this.bindLinearTransition(input, input.providerConfiguration);
  }

  private async bindLinearTransition(
    input: BindLinearConnectionInput,
    providerConfiguration?: CompleteLinearProviderApplicationInput["providerConfiguration"],
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, "linear");
      if (providerConfiguration === undefined) {
        await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      } else {
        await requireActivationCandidate(
          transaction,
          attempt,
          input.providerApplicationId,
          providerConfiguration,
          () =>
            transaction
              .select({ applicationId: schema.linearConnections.providerApplicationId })
              .from(schema.linearConnections)
              .for("update"),
        );
      }
      await lockExternal(this.locks, runtimeTransaction, "linear", input.linearOrganizationId);
      const [existing] = await transaction
        .select({
          id: schema.linearConnections.id,
          organizationId: schema.linearConnections.organizationId,
        })
        .from(schema.linearConnections)
        .where(eq(schema.linearConnections.linearOrganizationId, input.linearOrganizationId))
        .for("update");
      if (existing !== undefined && existing.organizationId !== attempt.organizationId) {
        throw new ConnectionConflictError();
      }
      if (existing === undefined) {
        await transaction.insert(schema.linearConnections).values({
          organizationId: attempt.organizationId,
          providerApplicationId: input.providerApplicationId,
          linearOrganizationId: input.linearOrganizationId,
          linearOrganizationName: input.linearOrganizationName,
          slug: await uniqueConnectionSlug(
            transaction,
            attempt.organizationId,
            "linear",
            input.linearOrganizationName,
          ),
          appUserId: input.appUserId,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken ?? null,
          accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
          scopes: input.scopes,
          connectedByUserId: attempt.userId,
        });
      } else {
        await transaction
          .update(schema.linearConnections)
          .set({
            providerApplicationId: input.providerApplicationId,
            linearOrganizationName: input.linearOrganizationName,
            appUserId: input.appUserId,
            accessToken: input.accessToken,
            refreshToken: input.refreshToken ?? null,
            accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
            scopes: input.scopes,
            connectedByUserId: attempt.userId,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.linearConnections.id, existing.id));
      }
      if (providerConfiguration !== undefined) {
        await persistProviderConfiguration(
          transaction,
          "linear",
          providerConfiguration,
          input.providerApplicationId,
          attempt.configurationVersion,
        );
      }
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async updateLinearTokens(input: UpdateLinearConnectionTokensInput): Promise<void> {
    await this.database
      .update(schema.linearConnections)
      .set({
        accessToken: input.accessToken,
        ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
        ...(input.accessTokenExpiresAt === undefined
          ? {}
          : { accessTokenExpiresAt: input.accessTokenExpiresAt }),
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(schema.linearConnections.id, input.connectionId));
  }

  async withLinearRefresh<T>(
    linearOrganizationId: string,
    operation: LinearConnectionRefreshOperation<T>,
  ): Promise<T> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      // This is intentionally the same transaction-scoped identity lock as OAuth rebind. In
      // particular, do not use the session-lock API here: the re-read and write below must share
      // this transaction's client so waiters cannot starve the lock holder's pool query.
      await lockExternal(this.locks, runtimeTransaction, "linear", linearOrganizationId);
      const [row] = await transaction
        .select()
        .from(schema.linearConnections)
        .where(eq(schema.linearConnections.linearOrganizationId, linearOrganizationId))
        .for("update");
      const connection = row === undefined ? undefined : linearConnection(row);
      return operation(connection, async (input) => {
        if (connection === undefined) throw new Error("Linear connection unavailable");
        await transaction
          .update(schema.linearConnections)
          .set({
            accessToken: input.accessToken,
            ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
            ...(input.accessTokenExpiresAt === undefined
              ? {}
              : { accessTokenExpiresAt: input.accessTokenExpiresAt }),
            ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.linearConnections.id, connection.id));
      });
    });
  }

  async advanceGitlabAttempt(input: AdvanceGitlabConnectionAttemptInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, attempt.provider);
      await requireConsumableAttempt(transaction, attempt);
      await transaction
        .update(schema.organizationConnectionAttempts)
        .set({
          phase: "gitlab_namespace_selection",
          stateVerifier: input.nextStateVerifier,
          pkceVerifier: null,
          candidateGrant: input.grant,
        })
        .where(eq(schema.organizationConnectionAttempts.id, attempt.id));
    });
  }

  async bindGitlab(input: BindGitlabConnectionInput): Promise<void> {
    await this.bindGitlabTransition(input);
  }

  async completeGitlabProviderApplication(
    input: CompleteGitlabProviderApplicationInput,
  ): Promise<void> {
    await this.bindGitlabTransition(input, input.providerConfiguration);
  }

  private async bindGitlabTransition(
    input: BindGitlabConnectionInput,
    providerConfiguration?: CompleteGitlabProviderApplicationInput["providerConfiguration"],
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, "gitlab");
      if (providerConfiguration === undefined) {
        await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      } else {
        await requireActivationCandidate(
          transaction,
          attempt,
          input.providerApplicationId,
          providerConfiguration,
          () =>
            transaction
              .select({ applicationId: schema.gitlabConnections.providerApplicationId })
              .from(schema.gitlabConnections)
              .for("update"),
        );
      }
      await lockExternal(this.locks, runtimeTransaction, "gitlab", String(input.namespace.id));
      const [existing] = await transaction
        .select({
          id: schema.gitlabConnections.id,
          organizationId: schema.gitlabConnections.organizationId,
        })
        .from(schema.gitlabConnections)
        .where(eq(schema.gitlabConnections.namespaceId, input.namespace.id))
        .for("update");
      if (existing !== undefined && existing.organizationId !== attempt.organizationId) {
        throw new ConnectionConflictError();
      }
      const tokens = {
        providerApplicationId: input.providerApplicationId,
        namespaceKind: input.namespace.kind,
        namespaceFullPath: input.namespace.fullPath,
        namespaceName: input.namespace.name,
        gitlabUserId: input.user.id,
        gitlabUsername: input.user.username,
        gitlabUserName: input.user.name,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
        accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
        scopes: input.scopes,
        connectedByUserId: attempt.userId,
      };
      let connectionId: string;
      if (existing === undefined) {
        const [inserted] = await transaction
          .insert(schema.gitlabConnections)
          .values({
            ...tokens,
            organizationId: attempt.organizationId,
            namespaceId: input.namespace.id,
            slug: await uniqueConnectionSlug(
              transaction,
              attempt.organizationId,
              "gitlab",
              input.namespace.fullPath,
            ),
          })
          .returning({ id: schema.gitlabConnections.id });
        connectionId = inserted!.id;
      } else {
        await transaction
          .update(schema.gitlabConnections)
          .set({ ...tokens, updatedAt: sql`clock_timestamp()` })
          .where(eq(schema.gitlabConnections.id, existing.id));
        connectionId = existing.id;
      }
      await replaceGitlabProjects(
        transaction,
        attempt.organizationId,
        connectionId,
        input.projects,
      );
      if (providerConfiguration !== undefined) {
        await persistProviderConfiguration(
          transaction,
          "gitlab",
          providerConfiguration,
          input.providerApplicationId,
          attempt.configurationVersion,
        );
      }
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async withGitlabRefresh<T>(
    namespaceId: number,
    operation: GitlabConnectionRefreshOperation<T>,
  ): Promise<T> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockExternal(this.locks, runtimeTransaction, "gitlab", String(namespaceId));
      const [row] = await transaction
        .select()
        .from(schema.gitlabConnections)
        .where(eq(schema.gitlabConnections.namespaceId, namespaceId))
        .for("update");
      const connection = row === undefined ? undefined : gitlabConnection(row);
      return operation(connection, async (input) => {
        if (connection === undefined) throw new Error("GitLab connection unavailable");
        await transaction
          .update(schema.gitlabConnections)
          .set({
            accessToken: input.accessToken,
            ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
            ...(input.accessTokenExpiresAt === undefined
              ? {}
              : { accessTokenExpiresAt: input.accessTokenExpiresAt }),
            ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.gitlabConnections.id, connection.id));
      });
    });
  }

  async findGitlab(namespaceId: number): Promise<GitlabConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.gitlabConnections)
      .where(eq(schema.gitlabConnections.namespaceId, namespaceId))
      .limit(1);
    return row === undefined ? undefined : gitlabConnection(row);
  }

  async findGitlabForOrganization(
    organizationId: string,
    connectionId: string,
  ): Promise<GitlabConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.gitlabConnections)
      .where(
        and(
          eq(schema.gitlabConnections.organizationId, organizationId),
          eq(schema.gitlabConnections.id, connectionId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : gitlabConnection(row);
  }

  async listGitlabProjects(
    organizationId: string,
    connectionId: string,
  ): Promise<GitlabProjectRecord[]> {
    const rows = await this.database
      .select()
      .from(schema.gitlabProjects)
      .where(
        and(
          eq(schema.gitlabProjects.organizationId, organizationId),
          eq(schema.gitlabProjects.connectionId, connectionId),
        ),
      )
      .orderBy(schema.gitlabProjects.pathWithNamespace);
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      connectionId: row.connectionId,
      projectId: row.projectId,
      pathWithNamespace: row.pathWithNamespace,
      defaultBranch: row.defaultBranch,
      webUrl: row.webUrl,
    }));
  }

  async recordGitlabProject(
    project: GitlabProjectInput,
  ): Promise<GitlabConnectionRecord | undefined> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      const [row] = await transaction
        .select()
        .from(schema.gitlabConnections)
        .where(
          sql`${schema.gitlabConnections.namespaceFullPath} || '/' = left(${project.pathWithNamespace}, length(${schema.gitlabConnections.namespaceFullPath}) + 1)`,
        )
        .orderBy(sql`length(${schema.gitlabConnections.namespaceFullPath}) desc`)
        .limit(1);
      if (row === undefined) return undefined;
      await upsertGitlabProject(transaction, row.organizationId, row.id, project);
      return gitlabConnection(row);
    });
  }

  async replaceGitlabProjects(
    organizationId: string,
    connectionId: string,
    projects: readonly GitlabProjectInput[],
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      const [connection] = await transaction
        .select({ id: schema.gitlabConnections.id })
        .from(schema.gitlabConnections)
        .where(
          and(
            eq(schema.gitlabConnections.id, connectionId),
            eq(schema.gitlabConnections.organizationId, organizationId),
          ),
        )
        .for("update");
      if (connection === undefined) throw new ConnectionAccessDeniedError();
      await replaceGitlabProjects(transaction, organizationId, connectionId, projects);
    });
  }

  private async bindExclusive(
    input: BindDiscordConnectionInput,
    provider: "discord" | "slack",
    externalId: string,
    insert: (transaction: HubTransaction, attempt: AttemptRow) => Promise<void>,
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, provider);
      await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      await lockExternal(this.locks, runtimeTransaction, provider, externalId);
      const conflict =
        provider === "discord"
          ? await transaction
              .select({ id: schema.discordConnections.id })
              .from(schema.discordConnections)
              .where(eq(schema.discordConnections.guildId, externalId))
              .limit(1)
          : await transaction
              .select({ id: schema.slackConnections.id })
              .from(schema.slackConnections)
              .where(eq(schema.slackConnections.teamId, externalId))
              .limit(1);
      if (conflict.length > 0) throw new ConnectionConflictError();
      await insert(transaction, attempt);
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async findGitHub(installationId: number): Promise<GitHubConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.installationId, installationId))
      .limit(1);
    return row === undefined ? undefined : githubConnection(row);
  }

  async removeGitHubByInstallationInTransaction(
    transaction: HubTransaction,
    installationId: number,
  ): Promise<void> {
    const [connection] = await transaction
      .select({ id: schema.githubConnections.id })
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.installationId, installationId))
      .for("update");
    if (connection === undefined) return;
    await clearGitHubConnectionReferences(transaction, connection.id);
    await transaction
      .delete(schema.githubConnections)
      .where(eq(schema.githubConnections.id, connection.id));
  }

  async disconnect(
    provider: ConnectionProvider,
    connectionId: string,
    access: ConnectionStartAuthority,
  ) {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, access);
      if (provider === "github") {
        const [connection] = await transaction
          .select({ id: schema.githubConnections.id })
          .from(schema.githubConnections)
          .where(
            and(
              eq(schema.githubConnections.id, connectionId),
              eq(schema.githubConnections.organizationId, access.organizationId),
            ),
          )
          .for("update");
        if (connection === undefined) throw new ConnectionAccessDeniedError();
        await clearGitHubConnectionReferences(transaction, connectionId);
        await transaction
          .delete(schema.githubConnections)
          .where(eq(schema.githubConnections.id, connectionId));
        return { provider } as const;
      }
      if (provider === "discord") {
        const [connection] = await transaction
          .select({ guildId: schema.discordConnections.guildId })
          .from(schema.discordConnections)
          .where(
            and(
              eq(schema.discordConnections.id, connectionId),
              eq(schema.discordConnections.organizationId, access.organizationId),
            ),
          )
          .for("update");
        if (connection === undefined) throw new ConnectionAccessDeniedError();
        await transaction
          .delete(schema.projectTriggerRoutes)
          .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
        await transaction
          .delete(schema.discordConnections)
          .where(eq(schema.discordConnections.id, connectionId));
        return {
          provider,
          guildId: connection.guildId,
        } as const;
      }
      if (provider === "linear") {
        const [connection] = await transaction
          .select({
            linearOrganizationId: schema.linearConnections.linearOrganizationId,
            accessToken: schema.linearConnections.accessToken,
          })
          .from(schema.linearConnections)
          .where(
            and(
              eq(schema.linearConnections.id, connectionId),
              eq(schema.linearConnections.organizationId, access.organizationId),
            ),
          )
          .for("update");
        if (connection === undefined) throw new ConnectionAccessDeniedError();
        await transaction
          .delete(schema.projectTriggerRoutes)
          .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
        await transaction
          .delete(schema.linearConnections)
          .where(eq(schema.linearConnections.id, connectionId));
        return {
          provider,
          linearOrganizationId: connection.linearOrganizationId,
          accessToken: connection.accessToken,
        } as const;
      }
      if (provider === "gitlab") {
        const [connection] = await transaction
          .select({
            namespaceId: schema.gitlabConnections.namespaceId,
            accessToken: schema.gitlabConnections.accessToken,
          })
          .from(schema.gitlabConnections)
          .where(
            and(
              eq(schema.gitlabConnections.id, connectionId),
              eq(schema.gitlabConnections.organizationId, access.organizationId),
            ),
          )
          .for("update");
        if (connection === undefined) throw new ConnectionAccessDeniedError();
        await transaction
          .delete(schema.projectTriggerRoutes)
          .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
        await transaction
          .delete(schema.gitlabConnections)
          .where(eq(schema.gitlabConnections.id, connectionId));
        return {
          provider,
          namespaceId: connection.namespaceId,
          accessToken: connection.accessToken,
        } as const;
      }
      const [connection] = await transaction
        .select({
          teamId: schema.slackConnections.teamId,
          botAccessToken: schema.slackConnections.botAccessToken,
        })
        .from(schema.slackConnections)
        .where(
          and(
            eq(schema.slackConnections.id, connectionId),
            eq(schema.slackConnections.organizationId, access.organizationId),
          ),
        )
        .for("update");
      if (connection === undefined) throw new ConnectionAccessDeniedError();
      await transaction
        .delete(schema.projectTriggerRoutes)
        .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
      await transaction
        .delete(schema.slackConnections)
        .where(eq(schema.slackConnections.id, connectionId));
      return {
        provider,
        teamId: connection.teamId,
        botAccessToken: connection.botAccessToken,
      } as const;
    });
  }

  async findDiscord(guildId: string): Promise<DiscordConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.discordConnections)
      .where(eq(schema.discordConnections.guildId, guildId))
      .limit(1);
    return row === undefined ? undefined : discordConnection(row);
  }

  async findDiscordForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.discordConnections)
      .where(
        and(
          eq(schema.discordConnections.organizationId, organizationId),
          eq(schema.discordConnections.guildId, guildId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : discordConnection(row);
  }

  async findSlack(teamId: string): Promise<SlackConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.slackConnections)
      .where(eq(schema.slackConnections.teamId, teamId))
      .limit(1);
    return row === undefined ? undefined : slackConnection(row);
  }

  async findSlackForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<SlackConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.slackConnections)
      .where(
        and(
          eq(schema.slackConnections.organizationId, organizationId),
          eq(schema.slackConnections.teamId, teamId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : slackConnection(row);
  }

  async findLinear(linearOrganizationId: string): Promise<LinearConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.linearConnections)
      .where(eq(schema.linearConnections.linearOrganizationId, linearOrganizationId))
      .limit(1);
    return row === undefined ? undefined : linearConnection(row);
  }

  async findLinearForOrganization(
    organizationId: string,
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.linearConnections)
      .where(
        and(
          eq(schema.linearConnections.organizationId, organizationId),
          eq(schema.linearConnections.linearOrganizationId, linearOrganizationId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : linearConnection(row);
  }

  async removeDiscord(guildId: string): Promise<void> {
    await this.database
      .delete(schema.discordConnections)
      .where(eq(schema.discordConnections.guildId, guildId));
  }
}

async function clearGitHubConnectionReferences(
  transaction: HubTransaction,
  connectionId: string,
): Promise<void> {
  await transaction
    .update(schema.projectConfigurationSources)
    .set({
      kind: "manual",
      githubConnectionId: null,
      githubRepositoryId: null,
      githubRepositoryFullName: null,
      githubDefaultBranch: null,
      automaticDeploymentEnabled: false,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(schema.projectConfigurationSources.githubConnectionId, connectionId));
  await transaction
    .delete(schema.projectTriggerRoutes)
    .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
  await transaction
    .update(schema.configurationSyncAttempts)
    .set({ githubConnectionId: null })
    .where(eq(schema.configurationSyncAttempts.githubConnectionId, connectionId));
}

function orExpiredOrConsumed() {
  return sql`${schema.organizationConnectionAttempts.expiresAt} <= clock_timestamp() or ${schema.organizationConnectionAttempts.consumedAt} is not null`;
}

async function lockAttempt(
  transaction: HubTransaction,
  input: ReadConnectionAttemptInput,
): Promise<AttemptRow> {
  const [attempt] = await transaction
    .select()
    .from(schema.organizationConnectionAttempts)
    .where(
      and(
        eq(schema.organizationConnectionAttempts.stateVerifier, input.stateVerifier),
        eq(schema.organizationConnectionAttempts.phase, input.phase),
        isNull(schema.organizationConnectionAttempts.consumedAt),
      ),
    )
    .for("update");
  if (
    attempt === undefined ||
    (await expiredAtDatabaseClock(transaction, attempt.expiresAt)) ||
    attempt.userId !== input.access.userId ||
    attempt.sessionId !== input.access.sessionId
  )
    throw new ConnectionAttemptUnavailableError();
  return attempt;
}

async function lockAccountSession(
  transaction: HubTransaction,
  access: ConnectionAccountAccess,
): Promise<void> {
  const [session] = await transaction
    .select({
      userId: schema.sessions.userId,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, access.sessionId))
    .for("update");
  if (
    session?.userId !== access.userId ||
    (await expiredAtDatabaseClock(transaction, session.expiresAt))
  )
    throw new ConnectionAccessDeniedError();
}

async function lockStartAuthority(
  transaction: HubTransaction,
  access: ConnectionStartAuthority,
): Promise<void> {
  await lockAccountSession(transaction, access);
  const [membership] = await transaction
    .select({ role: schema.members.role })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.id, access.membershipId),
        eq(schema.members.userId, access.userId),
        eq(schema.members.organizationId, access.organizationId),
        inArray(schema.members.role, ["owner", "admin"]),
      ),
    )
    .for("update");
  if (membership === undefined) throw new ConnectionAccessDeniedError();
}

async function lockStoredAuthority(
  transaction: HubTransaction,
  attempt: AttemptRow,
): Promise<void> {
  const [membership] = await transaction
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, attempt.userId),
        eq(schema.members.organizationId, attempt.organizationId),
        inArray(schema.members.role, ["owner", "admin"]),
      ),
    )
    .for("update");
  if (membership === undefined) throw new ConnectionAccessDeniedError();
}

async function expiredAtDatabaseClock(
  transaction: HubTransaction,
  expiresAt: Date,
): Promise<boolean> {
  const clock = await transaction.execute<{ expired: boolean }>(
    sql`select ${expiresAt}::timestamptz <= clock_timestamp() as expired`,
  );
  return clock.rows[0]?.expired ?? true;
}

async function lockExternal(
  locks: Locks,
  transaction: TransactionHandle,
  provider: ConnectionProvider,
  externalId: string,
): Promise<void> {
  await locks.withTxLock(
    transaction,
    JSON.stringify(["paseo-connection", provider, "external", externalId]),
  );
}

async function lockProviderApplication(
  locks: Locks,
  transaction: TransactionHandle,
  provider: ConnectionProvider,
): Promise<void> {
  await locks.withTxLock(transaction, JSON.stringify(["provider-application", provider]));
}

async function requireCurrentAttempt(
  transaction: HubTransaction,
  attempt: AttemptRow,
  bindingApplicationId?: string,
): Promise<void> {
  const applicationId = attempt.providerApplicationId;
  if (
    applicationId === null ||
    (bindingApplicationId !== undefined && applicationId !== bindingApplicationId)
  ) {
    throw providerApplicationChanged();
  }
  const [activation] = await transaction
    .select({
      applicationId: schema.runtimeProviderActivations.providerApplicationId,
      configurationVersion: schema.runtimeProviderActivations.configurationVersion,
    })
    .from(schema.runtimeProviderActivations)
    .where(eq(schema.runtimeProviderActivations.provider, attempt.provider))
    .for("update");
  if (
    activation?.applicationId !== applicationId ||
    activation?.configurationVersion !== attempt.configurationVersion
  ) {
    throw providerApplicationChanged();
  }
}

async function requireConsumableAttempt(
  transaction: HubTransaction,
  attempt: AttemptRow,
): Promise<void> {
  if (!attempt.activateConfiguration) {
    await requireCurrentAttempt(transaction, attempt);
    return;
  }
  if (
    attempt.provider !== "slack" &&
    attempt.provider !== "linear" &&
    attempt.provider !== "gitlab"
  ) {
    throw providerApplicationChanged();
  }
  const provider = attempt.provider;
  const [stored] = await transaction
    .select({
      version: schema.runtimeProviderConfiguration.version,
      identity: schema.runtimeProviderConfiguration.verifiedExternalIdentity,
    })
    .from(schema.runtimeProviderConfiguration)
    .where(eq(schema.runtimeProviderConfiguration.provider, provider))
    .for("update");
  const [activation] = await transaction
    .select({
      applicationId: schema.runtimeProviderActivations.providerApplicationId,
      configurationVersion: schema.runtimeProviderActivations.configurationVersion,
    })
    .from(schema.runtimeProviderActivations)
    .where(eq(schema.runtimeProviderActivations.provider, provider))
    .for("update");
  if (stored?.version !== (attempt.expectedConfigurationVersion ?? undefined)) {
    throw providerApplicationChanged();
  }
  if (stored === undefined) {
    if (activation !== undefined) throw providerApplicationChanged();
    return;
  }
  if (
    activation?.applicationId !== externalIdentityId(stored.identity) ||
    activation?.configurationVersion !== stored.version
  ) {
    throw providerApplicationChanged();
  }
}

async function requireActivationCandidate(
  transaction: HubTransaction,
  attempt: AttemptRow,
  bindingApplicationId: string,
  providerConfiguration: CompleteSlackProviderApplicationInput["providerConfiguration"],
  lockConnections: () => Promise<{ applicationId: string | null }[]>,
): Promise<void> {
  await requireConsumableAttempt(transaction, attempt);
  if (
    attempt.providerApplicationId !== bindingApplicationId ||
    externalIdentityId(providerConfiguration.identity) !== bindingApplicationId ||
    attempt.configurationVersion !== (providerConfiguration.expectedVersion ?? 0) + 1
  ) {
    throw providerApplicationChanged();
  }
  const connections = await lockConnections();
  if (connections.some((connection) => connection.applicationId !== bindingApplicationId)) {
    throw providerApplicationChanged();
  }
}

async function persistProviderConfiguration(
  transaction: HubTransaction,
  provider: "slack" | "linear" | "gitlab",
  providerConfiguration: CompleteSlackProviderApplicationInput["providerConfiguration"],
  applicationId: string,
  configurationVersion: number,
): Promise<void> {
  const [stored] = await transaction
    .select({ version: schema.runtimeProviderConfiguration.version })
    .from(schema.runtimeProviderConfiguration)
    .where(eq(schema.runtimeProviderConfiguration.provider, provider))
    .for("update");
  if (stored?.version !== providerConfiguration.expectedVersion) {
    const error = new Error("provider configuration changed");
    error.name = "ProviderConfigurationConflictError";
    throw error;
  }
  if (stored === undefined) {
    await transaction.insert(schema.runtimeProviderConfiguration).values({
      provider,
      configuration: providerConfiguration.configuration,
      verifiedExternalIdentity: providerConfiguration.identity,
      version: 1,
      verifiedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
      updatedByUserId: providerConfiguration.updatedByUserId,
    });
  } else {
    await transaction
      .update(schema.runtimeProviderConfiguration)
      .set({
        configuration: providerConfiguration.configuration,
        verifiedExternalIdentity: providerConfiguration.identity,
        version: sql`${schema.runtimeProviderConfiguration.version} + 1`,
        verifiedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
        updatedByUserId: providerConfiguration.updatedByUserId,
      })
      .where(eq(schema.runtimeProviderConfiguration.provider, provider));
  }
  await writeProviderActivation(transaction, provider, applicationId, configurationVersion);
}

async function replaceGitlabProjects(
  transaction: HubTransaction,
  organizationId: string,
  connectionId: string,
  projects: readonly GitlabProjectInput[],
): Promise<void> {
  const keep = projects.map((project) => project.projectId);
  await transaction
    .delete(schema.gitlabProjects)
    .where(
      keep.length === 0
        ? eq(schema.gitlabProjects.connectionId, connectionId)
        : and(
            eq(schema.gitlabProjects.connectionId, connectionId),
            notInArray(schema.gitlabProjects.projectId, keep),
          ),
    );
  for (const project of projects) {
    await upsertGitlabProject(transaction, organizationId, connectionId, project);
  }
}

async function upsertGitlabProject(
  transaction: HubTransaction,
  organizationId: string,
  connectionId: string,
  project: GitlabProjectInput,
): Promise<void> {
  await transaction
    .insert(schema.gitlabProjects)
    .values({ organizationId, connectionId, ...project })
    .onConflictDoUpdate({
      target: [schema.gitlabProjects.connectionId, schema.gitlabProjects.projectId],
      set: {
        pathWithNamespace: project.pathWithNamespace,
        defaultBranch: project.defaultBranch,
        webUrl: project.webUrl,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

async function writeProviderActivation(
  transaction: HubTransaction,
  provider: ConnectionProvider,
  applicationId: string,
  configurationVersion: number,
): Promise<void> {
  await transaction
    .insert(schema.runtimeProviderActivations)
    .values({ provider, providerApplicationId: applicationId, configurationVersion })
    .onConflictDoUpdate({
      target: schema.runtimeProviderActivations.provider,
      set: {
        providerApplicationId: applicationId,
        configurationVersion,
        activatedAt: sql`clock_timestamp()`,
      },
    });
}

function externalIdentityId(value: unknown): string | undefined {
  return value !== null && typeof value === "object" && typeof Reflect.get(value, "id") === "string"
    ? String(Reflect.get(value, "id"))
    : undefined;
}

function providerApplicationChanged(): Error {
  const error = new Error("provider application changed");
  error.name = "ProviderApplicationChangedError";
  return error;
}

async function consumeLockedAttempt(transaction: HubTransaction, attemptId: string): Promise<void> {
  await transaction
    .update(schema.organizationConnectionAttempts)
    .set({ consumedAt: sql`clock_timestamp()`, pkceVerifier: null, candidateGrant: null })
    .where(eq(schema.organizationConnectionAttempts.id, attemptId));
}

function initialConnectionAttemptPhase(provider: ConnectionProvider): ConnectionAttemptPhase {
  if (provider === "github") return "github_setup";
  if (provider === "discord") return "discord_authorization";
  if (provider === "gitlab") return "gitlab_authorization";
  return provider === "slack" ? "slack_authorization" : "linear_authorization";
}

function toAttempt(row: AttemptRow): ConnectionAttemptRecord {
  return {
    id: row.id,
    provider: row.provider,
    phase: row.phase,
    organizationId: row.organizationId,
    returnRoute: row.returnRoute,
    userId: row.userId,
    sessionId: row.sessionId,
    candidateExternalId: row.candidateExternalId,
    pkceVerifier: row.pkceVerifier,
    candidateGrant: row.candidateGrant,
    configurationVersion: row.configurationVersion,
    providerApplicationId: row.providerApplicationId,
    callbackOrigin: row.callbackOrigin,
    configurationSnapshot: row.configurationSnapshot,
    expectedConfigurationVersion: row.expectedConfigurationVersion,
    activateConfiguration: row.activateConfiguration,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

function githubConnection(
  row: typeof schema.githubConnections.$inferSelect,
): GitHubConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    installationId: row.installationId,
    accountId: row.accountId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    status: row.status,
    providerApplicationId: row.providerApplicationId,
  };
}
function discordConnection(
  row: typeof schema.discordConnections.$inferSelect,
): DiscordConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    guildId: row.guildId,
    guildName: row.guildName,
    providerApplicationId: row.providerApplicationId,
  };
}
function slackConnection(row: typeof schema.slackConnections.$inferSelect): SlackConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    teamId: row.teamId,
    teamName: row.teamName,
    botUserId: row.botUserId,
    botAccessToken: row.botAccessToken,
    scopes: row.scopes,
    providerApplicationId: row.providerApplicationId,
  };
}
function linearConnection(
  row: typeof schema.linearConnections.$inferSelect,
): LinearConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    providerApplicationId: row.providerApplicationId,
    linearOrganizationId: row.linearOrganizationId,
    linearOrganizationName: row.linearOrganizationName,
    appUserId: row.appUserId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    scopes: row.scopes,
  };
}

function gitlabConnection(
  row: typeof schema.gitlabConnections.$inferSelect,
): GitlabConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    providerApplicationId: row.providerApplicationId,
    namespace: {
      id: row.namespaceId,
      kind: row.namespaceKind,
      fullPath: row.namespaceFullPath,
      name: row.namespaceName,
    },
    user: { id: row.gitlabUserId, username: row.gitlabUsername, name: row.gitlabUserName },
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    scopes: row.scopes,
  };
}

async function uniqueConnectionSlug(
  transaction: HubTransaction,
  organizationId: string,
  provider: ConnectionProvider,
  identity: string,
): Promise<string> {
  const base = `${slugify(identity, "connection")}-${provider}`;
  const rows = await transaction.execute<{ slug: string }>(sql`
    select slug from (
      select slug from github_connections where organization_id = ${organizationId}
      union all
      select slug from slack_connections where organization_id = ${organizationId}
      union all
      select slug from discord_connections where organization_id = ${organizationId}
      union all
      select slug from linear_connections where organization_id = ${organizationId}
      union all
      select slug from gitlab_connections where organization_id = ${organizationId}
    ) slugs
    where slug = ${base} or slug like ${`${base}-%`}
    order by slug
  `);
  const used = new Set(rows.rows.map((row) => row.slug));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
