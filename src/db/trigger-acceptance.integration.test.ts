import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPostgresQueryRuntime } from "./test-utils/runtime.js";
import { createDatabase } from "./test-utils/runtime.js";

describe("trigger acceptance persistence", () => {
  let postgres: StartedPostgreSqlContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    databaseUrl = postgres.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("does not resolve another organization when delivery keys collide", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);

    await client.query(`
      insert into organization (id, name, slug) values
        ('manual-org-a', 'Manual A', 'manual-a'),
        ('manual-org-b', 'Manual B', 'manual-b');
      insert into projects (id, organization_id, name, slug)
      values
        ('10000000-0000-4000-8000-000000000001', 'manual-org-a', 'Default', 'same-project'),
        ('20000000-0000-4000-8000-000000000001', 'manual-org-b', 'Default', 'same-project');
    `);
    await client.close();
    for (const [projectId, contentHash] of [
      ["10000000-0000-4000-8000-000000000001", "manual-org-a-config"],
      ["20000000-0000-4000-8000-000000000001", "manual-org-b-config"],
    ] as const) {
      const revision = await database.insertProjectConfigurationRevision({
        projectId,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash,
      });
      await database.activateProjectConfigurationRevision(projectId, revision.id);
    }

    const first = await database.persistManualEvent(
      input("manual-org-a", "10000000-0000-4000-8000-000000000001"),
    );
    const second = await database.persistManualEvent(
      input("manual-org-b", "20000000-0000-4000-8000-000000000001"),
    );
    assert.equal(first.status, "accepted");
    assert.equal(second.status, "accepted");
    if (first.status !== "accepted" || second.status !== "accepted")
      throw new Error("expected accepted triggers");
    assert.notEqual(first.event.providerEventReceiptId, second.event.providerEventReceiptId);

    const duplicate = await database.persistManualEvent(
      input("manual-org-a", "10000000-0000-4000-8000-000000000001"),
    );
    assert.equal(duplicate.status, "accepted");
    if (duplicate.status !== "accepted") throw new Error("expected replayed accepted trigger");
    assert.equal(duplicate.event.providerEventReceiptId, first.event.providerEventReceiptId);
    assert.equal(duplicate.event.organizationId, "manual-org-a");
    assert.equal(duplicate.event.projectId, "10000000-0000-4000-8000-000000000001");
    await database.close();
  }, 120_000);

  it("lists only receipts with a committed bounded drop reason", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);

    await client.query(`
      insert into organization (id, name, slug)
      values ('drop-reason-org', 'Drop Reason', 'drop-reason');
      insert into projects (id, organization_id, name, slug)
      values ('30000000-0000-4000-8000-000000000001', 'drop-reason-org', 'Default', 'default');
    `);
    await client.close();
    const revision = await database.insertProjectConfigurationRevision({
      projectId: "30000000-0000-4000-8000-000000000001",
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "drop-reason-config",
    });
    await database.activateProjectConfigurationRevision(
      "30000000-0000-4000-8000-000000000001",
      revision.id,
    );
    const receipt = await database.persistManualEvent({
      organizationId: "drop-reason-org",
      projectId: "30000000-0000-4000-8000-000000000001",
      source: "manual.run",
      deliveryId: "drop-reason-delivery",
      receivedAt: new Date(),
      payload: { private: "PRIVATE-EVENT-BODY" },
    });
    if (receipt.status !== "accepted") throw new Error("expected accepted receipt");

    assert.deepEqual(
      await database.listUnroutedProviderEventsForOrganization("drop-reason-org"),
      [],
    );
    await database.markProviderEventDropped(
      receipt.event.providerEventReceiptId,
      "trigger_filters_rejected",
    );
    const [unrouted] = await database.listUnroutedProviderEventsForOrganization("drop-reason-org");
    assert.equal(unrouted?.droppedReason, "trigger_filters_rejected");
    assert.equal("payload" in (unrouted ?? {}), false);
    await database.close();
  }, 120_000);

  it("durably drops Linear events until the connection has the required scopes", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    const organizationId = "linear-scope-org";
    const projectId = "40000000-0000-4000-8000-000000000001";
    const connectionId = "40000000-0000-4000-8000-000000000002";

    await client.query(`
      insert into organization (id, name, slug)
      values ('${organizationId}', 'Linear Scope', 'linear-scope');
      insert into projects (id, organization_id, name, slug)
      values ('${projectId}', '${organizationId}', 'Default', 'default');
      insert into linear_connections
        (id, organization_id, linear_organization_id, provider_application_id, slug,
         linear_organization_name, app_user_id, access_token, refresh_token, scopes)
      values
        ('${connectionId}', '${organizationId}', 'linear-scope-workspace', 'linear-app',
         'linear-scope', 'Linear Scope', 'linear-app-user', 'linear-access-token',
         'linear-refresh-token', '["read"]'::jsonb);
    `);
    const revision = await database.insertProjectConfigurationRevision({
      projectId,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "linear-scope-config",
    });
    await database.activateProjectConfigurationRevision(projectId, revision.id, [
      {
        provider: "linear",
        connectionId,
        resourceId: "linear-project",
        triggerName: "linear-issue",
      },
    ]);

    const dropped = await database.acceptLinearEvent({
      linearOrganizationId: "linear-scope-workspace",
      projectId: "linear-project",
      deliveryId: "linear-under-scoped",
      source: "linear.issue",
      payload: {},
      receivedAt: new Date(0),
    });
    assert.equal(dropped.status, "dropped");
    if (dropped.status !== "dropped") throw new Error("expected an under-scoped drop");
    assert.equal(dropped.reason, "configuration_unavailable");
    assert.equal(
      (await database.findProviderEventReceiptByDeliveryId("linear-under-scoped", organizationId))
        ?.droppedReason,
      "configuration_unavailable",
    );

    await client.query(
      `update linear_connections set scopes = '["read", "comments:create"]'::jsonb
       where id = '${connectionId}'`,
    );
    const accepted = await database.acceptLinearEvent({
      linearOrganizationId: "linear-scope-workspace",
      projectId: "linear-project",
      deliveryId: "linear-reauthorized",
      source: "linear.issue",
      payload: {},
      receivedAt: new Date(1),
    });
    assert.equal(accepted.status, "accepted");
    if (accepted.status === "accepted") assert.equal(accepted.events[0]?.projectId, projectId);

    await client.query(
      `update linear_connections
       set refresh_token = null, access_token_expires_at = '1970-01-01T00:00:00.000Z'
       where id = '${connectionId}'`,
    );
    const expired = await database.acceptLinearEvent({
      linearOrganizationId: "linear-scope-workspace",
      projectId: "linear-project",
      deliveryId: "linear-expired-without-refresh",
      source: "linear.issue",
      payload: {},
      receivedAt: new Date(120_000),
    });
    assert.equal(expired.status, "dropped");
    if (expired.status !== "dropped") throw new Error("expected an expired-token drop");
    assert.equal(expired.reason, "configuration_unavailable");

    await client.close();
    await database.close();
  }, 120_000);
  it("records a GitLab project under the longest covering namespace and gates on the token", async () => {
    const database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    const organizationId = "gitlab-scope-org";
    const projectId = "50000000-0000-4000-8000-000000000001";
    const groupConnectionId = "50000000-0000-4000-8000-000000000002";
    const subgroupConnectionId = "50000000-0000-4000-8000-000000000003";

    await client.query(`
      insert into organization (id, name, slug)
      values ('${organizationId}', 'GitLab Scope', 'gitlab-scope');
      insert into projects (id, organization_id, name, slug)
      values ('${projectId}', '${organizationId}', 'Default', 'default');
      insert into gitlab_connections
        (id, organization_id, namespace_id, namespace_kind, namespace_full_path, namespace_name,
         provider_application_id, slug, gitlab_user_id, gitlab_username, gitlab_user_name,
         access_token, refresh_token, scopes)
      values
        ('${groupConnectionId}', '${organizationId}', 42, 'group', 'acme', 'Acme',
         'gitlab-app', 'acme-gitlab', 7, 'acme-bot', 'Acme Bot',
         'gitlab-access-token', 'gitlab-refresh-token', '["api"]'::jsonb),
        ('${subgroupConnectionId}', '${organizationId}', 43, 'group', 'acme/platform', 'Platform',
         'gitlab-app', 'acme-platform-gitlab', 7, 'acme-bot', 'Acme Bot',
         'gitlab-access-token', 'gitlab-refresh-token', '["api"]'::jsonb);
    `);

    const covering = await database.recordGitlabProject({
      projectId: 4201,
      pathWithNamespace: "acme/platform/api",
      defaultBranch: "main",
      webUrl: "https://gitlab.com/acme/platform/api",
    });
    assert.equal(covering?.id, subgroupConnectionId);
    const sibling = await database.recordGitlabProject({
      projectId: 4202,
      pathWithNamespace: "acme/web",
      defaultBranch: "main",
      webUrl: "https://gitlab.com/acme/web",
    });
    assert.equal(sibling?.id, groupConnectionId);
    assert.equal(
      await database.recordGitlabProject({
        projectId: 4203,
        pathWithNamespace: "acme-corp/web",
        defaultBranch: null,
        webUrl: "https://gitlab.com/acme-corp/web",
      }),
      undefined,
    );
    assert.deepEqual(
      (await database.listGitlabProjects(organizationId, subgroupConnectionId)).map(
        ({ projectId: id, pathWithNamespace }) => [id, pathWithNamespace],
      ),
      [[4201, "acme/platform/api"]],
    );

    const revision = await database.insertProjectConfigurationRevision({
      projectId,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "gitlab-scope-config",
    });
    await database.activateProjectConfigurationRevision(projectId, revision.id, [
      {
        provider: "gitlab",
        connectionId: subgroupConnectionId,
        resourceId: "4201",
        triggerName: "gitlab-note",
      },
    ]);

    const accepted = await database.acceptGitlabEvent({
      namespaceId: 43,
      projectId: 4201,
      deliveryId: "gitlab-routed",
      source: "gitlab.note",
      payload: {},
      receivedAt: new Date(1),
    });
    assert.equal(accepted.status, "accepted");
    if (accepted.status === "accepted") {
      assert.equal(accepted.events[0]?.projectId, projectId);
      assert.equal(accepted.events[0]?.resourceId, "4201");
    }

    const unrouted = await database.acceptGitlabEvent({
      namespaceId: 42,
      projectId: 4202,
      deliveryId: "gitlab-unrouted",
      source: "gitlab.push",
      payload: {},
      receivedAt: new Date(2),
    });
    assert.equal(unrouted.status, "dropped");
    if (unrouted.status === "dropped") assert.equal(unrouted.reason, "no_project_route");

    const unbound = await database.acceptGitlabEvent({
      namespaceId: 99,
      projectId: 4203,
      deliveryId: "gitlab-unbound",
      source: "gitlab.push",
      payload: {},
      receivedAt: new Date(3),
    });
    assert.equal(unbound.status, "dropped");
    if (unbound.status === "dropped") assert.equal(unbound.reason, "gitlab_unbound");

    await client.query(
      `update gitlab_connections
       set refresh_token = null, access_token_expires_at = '1970-01-01T00:00:00.000Z'
       where id = '${subgroupConnectionId}'`,
    );
    const expired = await database.acceptGitlabEvent({
      namespaceId: 43,
      projectId: 4201,
      deliveryId: "gitlab-expired-without-refresh",
      source: "gitlab.note",
      payload: {},
      receivedAt: new Date(120_000),
    });
    assert.equal(expired.status, "dropped");
    if (expired.status === "dropped") assert.equal(expired.reason, "configuration_unavailable");

    await client.close();
    await database.close();
  }, 120_000);
});

function input(organizationId: string, projectId: string) {
  return {
    organizationId,
    projectId,
    source: "manual.run",
    deliveryId: "same-delivery-key",
    receivedAt: new Date(),
    payload: { authenticatedBy: { kind: "api-key", keyId: `key-${organizationId}` } },
  } as const;
}
