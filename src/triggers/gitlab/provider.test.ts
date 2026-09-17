import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { GitlabApiClient } from "../../providers/gitlab/client.js";
import { issueHook, noteHook, pushHook } from "../../test-utils/gitlab-hooks.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch, type ExternalTrigger } from "../index.js";
import { normalizeGitlabEvent } from "./events.js";
import { createGitlabTriggerProvider, type GitlabReactionClient } from "./provider.js";

describe("GitLab trigger provider", () => {
  it("matches a note, keys the conversation on the item and exposes a safe context", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createGitlabTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestReactions(),
    });

    const matches = await provider.match(external(project.id, revision.id, noteHook()));
    if (typeof matches === "string") throw new Error(`expected a match, got ${matches}`);
    const match = matches[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.deepEqual(match.conversation, {
      key: JSON.stringify(["gitlab", 4201, "issue", 17]),
      label: "acme/api#17",
      url: "https://gitlab.com/acme/api/-/issues/17",
    });
    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: "@paseo please take a look",
      inputs: {},
    });
    assert.deepEqual(match.triggerContext.target, { namespaceId: 42, projectId: 4201 });
    assert.deepEqual(match.triggerContext.reactionSubject, {
      item: { type: "issue", iid: 17 },
      noteId: 1241,
    });
    const context = await provider.materializeContext?.({
      executionId: "gitlab-context",
      organizationId: "org_1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111111",
      triggerContext: match.triggerContext,
    });
    assert.deepEqual(context, {
      gitlab: {
        delivery_id: "gitlab-delivery-1",
        event_name: "gitlab.note",
        project: {
          id: 4201,
          path_with_namespace: "acme/api",
          web_url: "https://gitlab.com/acme/api",
        },
        received_at: "2026-09-17T00:00:00.000Z",
        confidential: false,
        user: { username: "alice", name: "Alice" },
        item: {
          type: "issue",
          iid: 17,
          title: "Ship the feature",
          description: "Useful context",
          url: "https://gitlab.com/acme/api/-/issues/17",
          labels: ["bug"],
        },
        note: {
          id: 1241,
          body: "@paseo please take a look",
          url: "https://gitlab.com/acme/api/-/issues/17#note_1241",
        },
        push: null,
      },
    });
    assert.equal(JSON.stringify(context).includes("REDACTED"), false);
    assert.equal("materializeLaunch" in provider, false);
  });

  it("awards eyes on dispatch and replaces it at the end of the run", async () => {
    const { project, revision, store } = await activeConfiguration();
    const reactions = new TestReactions();
    const provider = createGitlabTriggerProvider({
      configurationStoreForProject: () => store,
      reactions,
    });
    const matches = await provider.match(external(project.id, revision.id, noteHook()));
    if (typeof matches === "string") throw new Error("expected a match");
    const match = matches[0]!;

    const state = await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    assert.deepEqual(state, { awardId: 1 });
    assert.deepEqual(
      await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext, state),
      { awardId: 1 },
    );
    await provider.onAgentExecutionCompleted?.(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded" },
      state,
    );
    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom", {
      awardId: 2,
    });
    await provider.onMachineTerminated?.(match.triggerContext, "gone", null);

    assert.deepEqual(
      reactions.created.map(({ name, noteId }) => ({ name, noteId })),
      [
        { name: "eyes", noteId: 1241 },
        { name: "thumbsup", noteId: 1241 },
        { name: "thumbsdown", noteId: 1241 },
        { name: "thumbsdown", noteId: 1241 },
      ],
    );
    assert.deepEqual(
      reactions.deleted.map(({ awardId }) => awardId),
      [1, 2],
    );
  });

  it("awards on the item itself for issue events and never for pushes", async () => {
    const { project, revision, store } = await activeConfiguration("gitlab.issue_created");
    const reactions = new TestReactions();
    const provider = createGitlabTriggerProvider({
      configurationStoreForProject: () => store,
      reactions,
    });
    const matches = await provider.match(external(project.id, revision.id, issueHook("open")));
    if (typeof matches === "string") throw new Error("expected a match");
    const match = matches[0]!;
    assert.deepEqual(match.triggerContext.reactionSubject, {
      item: { type: "issue", iid: 17 },
      noteId: null,
    });
    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    assert.deepEqual(reactions.created[0]?.noteId, null);

    const pushed = await activeConfiguration("gitlab.push");
    const pushProvider = createGitlabTriggerProvider({
      configurationStoreForProject: () => pushed.store,
      reactions,
    });
    const pushMatches = await pushProvider.match(
      external(pushed.project.id, pushed.revision.id, pushHook()),
    );
    if (typeof pushMatches === "string") throw new Error("expected a push match");
    const pushMatch = pushMatches[0];
    if (pushMatch === undefined) throw new Error("expected a push match");
    assert.equal(pushMatch.conversation, null);
    assert.equal(pushMatch.triggerContext.reactionSubject, null);
    assert.equal(
      await pushProvider.onDispatchAccepted?.(pushMatch.triggerContext, pushMatch.outputContext),
      null,
    );
  });

  it("reports the routing outcome when nothing matches", async () => {
    const { project, revision, store } = await activeConfiguration();
    const provider = createGitlabTriggerProvider({
      configurationStoreForProject: () => store,
      reactions: new TestReactions(),
    });
    assert.equal(
      await provider.match(external(project.id, revision.id, issueHook("open"))),
      "no_trigger_for_source",
    );
    assert.equal(
      await provider.match(external(project.id, revision.id, noteHook({ body: "no mention" }))),
      "trigger_filters_rejected",
    );
    assert.equal(
      await provider.match({
        ...external(project.id, revision.id, noteHook()),
        configurationRevisionId: "11111111-1111-4111-8111-111111111199",
      }),
      "configuration_unavailable",
    );
  });
});

async function activeConfiguration(on = "gitlab.note") {
  return createActiveProjectConfiguration(createMemoryDatabase(), {
    environments: [{ name: "runner", kind: "daemon", daemon: "laptop", cwd: "/repo" }],
    triggers: [
      {
        name: "gitlab-mention",
        on,
        max_runtime: "2h",
        filters: {
          project: "acme/api",
          from_users: ["alice"],
          ...(on === "gitlab.note" ? { contains: "@paseo" } : {}),
        },
        steps: [
          {
            id: "step",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Handle the GitLab event." }],
            allow_outputs: [{ type: "gitlab.reply" }],
            auto_archive: true,
          },
        ],
      },
    ],
  });
}

function external(
  projectId: string,
  configurationRevisionId: string,
  hook: unknown,
): ExternalTrigger {
  const event = normalizeGitlabEvent(hook);
  if (event === undefined) throw new Error("fixture did not normalize");
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "org_1",
    projectId,
    configurationRevisionId,
    source: `gitlab.${event.type}`,
    deliveryId: "gitlab-delivery-1",
    receivedAt: new Date("2026-09-17T00:00:00.000Z"),
    payload: { namespaceId: 42, event },
    connectionId: null,
    resourceId: "4201",
  };
}

class TestReactions implements GitlabReactionClient {
  readonly created: Array<Parameters<GitlabApiClient["createAward"]>[0]> = [];
  readonly deleted: Array<Parameters<GitlabApiClient["deleteAward"]>[0]> = [];

  async createAward(input: Parameters<GitlabApiClient["createAward"]>[0]) {
    this.created.push(input);
    return { id: this.created.length };
  }

  async deleteAward(input: Parameters<GitlabApiClient["deleteAward"]>[0]) {
    this.deleted.push(input);
  }
}
