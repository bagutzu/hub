import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import { normalizeGitlabEvent, type NormalizedGitlabEvent } from "./events.js";
import { issueHook, mergeRequestHook, noteHook, pushHook } from "../../test-utils/gitlab-hooks.js";
import { matchGitlabTriggers, readGitlabInvocationParserMessage } from "./match.js";

describe("GitLab trigger matching", () => {
  it.each([
    {
      acceptance: "issue_created accepts only opened issues",
      on: "gitlab.issue_created",
      event: hook(issueHook("open")),
      expected: 1,
    },
    {
      acceptance: "issue_created rejects other actions",
      on: "gitlab.issue_created",
      event: hook(issueHook("close")),
      expected: 0,
    },
    {
      acceptance: "merge_request_created accepts only opened merge requests",
      on: "gitlab.merge_request_created",
      event: hook(mergeRequestHook("open")),
      expected: 1,
    },
    {
      acceptance: "merge_request_created rejects a merge",
      on: "gitlab.merge_request_created",
      event: hook(mergeRequestHook("merge")),
      expected: 0,
    },
    {
      acceptance: "issue notes are separate from merge request notes",
      on: "gitlab.issue_comment_created",
      event: hook(noteHook()),
      expected: 1,
    },
    {
      acceptance: "merge request notes are separate from issue notes",
      on: "gitlab.merge_request_comment_created",
      event: hook(noteHook({ noteable: "MergeRequest" })),
      expected: 1,
    },
    {
      acceptance: "issue_comment_created rejects a merge request note",
      on: "gitlab.issue_comment_created",
      event: hook(noteHook({ noteable: "MergeRequest" })),
      expected: 0,
    },
    {
      acceptance: "label_added matches an added label accent-insensitively",
      on: "gitlab.issue_label_added",
      filters: { label: "READY-FOR-AGENT" },
      event: hook(labelAdded("ready-for-agent")),
      expected: 1,
    },
    {
      acceptance: "label_added rejects a label that was already there",
      on: "gitlab.issue_label_added",
      filters: { label: "bug" },
      event: hook(labelAdded("ready-for-agent")),
      expected: 0,
    },
    {
      acceptance: "labels requires every current label",
      on: "gitlab.issue_comment_created",
      filters: { labels: ["BUG"] },
      event: hook(noteHook()),
      expected: 1,
    },
    {
      acceptance: "labels rejects a missing current label",
      on: "gitlab.issue_comment_created",
      filters: { labels: ["bug", "backend"] },
      event: hook(noteHook()),
      expected: 0,
    },
    {
      acceptance: "the raw source matches every action",
      on: "gitlab.merge_request",
      event: hook(mergeRequestHook("merge")),
      expected: 1,
    },
    {
      acceptance: "project filters on the path with namespace",
      on: "gitlab.note",
      filters: { project: "acme/other" },
      event: hook(noteHook()),
      expected: 0,
    },
    {
      acceptance: "contains filters on the note body",
      on: "gitlab.note",
      filters: { contains: "@paseo" },
      event: hook(noteHook({ body: "no mention here" })),
      expected: 0,
    },
    {
      acceptance: "pattern anchors at the start of the text",
      on: "gitlab.note",
      filters: { pattern: "@paseo" },
      event: hook(noteHook({ body: "please @paseo" })),
      expected: 0,
    },
    {
      acceptance: "from_users rejects another GitLab username",
      on: "gitlab.note",
      filters: { from_users: ["bob"] },
      event: hook(noteHook()),
      expected: 0,
    },
    {
      acceptance: "a wildcard allowlist accepts any user",
      on: "gitlab.push",
      filters: { from_users: ["*"] },
      event: hook(pushHook()),
      expected: 1,
    },
  ])("$acceptance", ({ on, filters, event, expected }) => {
    const config = configFor({ project: "acme/api", from_users: ["alice"], ...filters }, on);
    assert.equal(matchGitlabTriggers(config, event).length, expected);
  });

  it("fails closed without a from_users allowlist and on a connection mismatch", () => {
    const event = hook(noteHook());
    const config = configFor({ project: "acme/api", from_users: ["alice"] }, "gitlab.note");
    assert.equal(matchGitlabTriggers(config, event, "connection-1").length, 1);
    assert.equal(
      matchGitlabTriggers(
        { triggers: [{ name: "t", on: "gitlab.note", filters: { project: "acme/api" } }] },
        event,
      ).length,
      0,
    );
    assert.equal(
      matchGitlabTriggers(
        {
          triggers: [
            {
              name: "t",
              on: "gitlab.note",
              filters: {
                from_users: ["alice"],
                connectionId: "11111111-1111-4111-8111-111111111111",
                resourceId: "4201",
              },
            },
          ],
        },
        event,
        "22222222-2222-4222-8222-222222222222",
      ).length,
      0,
    );
  });

  it("hands the parser the text from the contains marker on", () => {
    const event = hook(noteHook({ body: "hey @paseo priority=high look" }));
    assert.equal(
      readGitlabInvocationParserMessage(event, { contains: "@paseo", from_users: ["alice"] }),
      "@paseo priority=high look",
    );
  });
});

function hook(payload: unknown): NormalizedGitlabEvent {
  const event = normalizeGitlabEvent(payload);
  if (event === undefined) throw new Error("fixture did not normalize");
  return event;
}

function labelAdded(label: string) {
  return issueHook("update", {
    labels: [{ title: "bug" }, { title: label }],
    changes: {
      labels: { previous: [{ title: "bug" }], current: [{ title: "bug" }, { title: label }] },
    },
  });
}

function configFor(filters: Record<string, unknown>, on: string) {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "laptop", cwd: "/repo" }],
    triggers: [
      {
        name: "gitlab-trigger",
        on,
        max_runtime: "2h",
        filters,
        steps: [
          {
            id: "step",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Handle it." }],
            allow_outputs: [{ type: "gitlab.reply" }],
            auto_archive: true,
          },
        ],
      },
    ],
  });
}
