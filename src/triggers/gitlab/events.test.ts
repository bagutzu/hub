import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  PROJECT,
  PROJECT_RAW,
  issueHook,
  mergeRequestHook,
  noteHook,
  pushHook,
} from "../../test-utils/gitlab-hooks.js";
import { classifyGitlabEvent, normalizeGitlabEvent, type NormalizedGitlabEvent } from "./events.js";

describe("GitLab event normalization", () => {
  it("normalizes a note on an issue with the item it belongs to", () => {
    const event = normalized(noteHook());
    assert.deepEqual(event, {
      type: "note",
      project: PROJECT,
      user: { id: 7, username: "alice", name: "Alice" },
      note: {
        id: 1241,
        body: "@paseo please take a look",
        url: "https://gitlab.com/acme/api/-/issues/17#note_1241",
      },
      item: {
        type: "issue",
        iid: 17,
        title: "Ship the feature",
        description: "Useful context",
        url: "https://gitlab.com/acme/api/-/issues/17",
        labels: ["bug"],
        confidential: false,
      },
    });
    assert.equal(classifyGitlabEvent(event).semanticEvent, "gitlab.issue_comment_created");
  });

  it("marks confidential notes and issues without changing their event", () => {
    const note = normalized({ ...noteHook(), event_type: "confidential_note" });
    assert.equal(note.type === "note" && note.item.confidential, true);
    const issue = normalized({
      ...issueHook("open"),
      event_type: "confidential_issue",
    });
    assert.equal(issue.type === "issue" && issue.item.confidential, true);
    assert.equal(classifyGitlabEvent(issue).semanticEvent, "gitlab.issue_created");
  });

  it("normalizes a merge request note by its noteable type", () => {
    const event = normalized(noteHook({ noteable: "MergeRequest" }));
    assert.equal(event.type, "note");
    assert.equal(event.type === "note" && event.item.type, "merge_request");
    assert.equal(
      event.type === "note" && event.item.url,
      "https://gitlab.com/acme/api/-/merge_requests/17",
    );
    assert.equal(classifyGitlabEvent(event).semanticEvent, "gitlab.merge_request_comment_created");
  });

  it("ignores notes on commits and snippets, and unknown object kinds", () => {
    assert.equal(normalizeGitlabEvent(noteHook({ noteable: "Commit" })), undefined);
    assert.equal(
      normalizeGitlabEvent({ object_kind: "pipeline", project: PROJECT_RAW }),
      undefined,
    );
    assert.equal(normalizeGitlabEvent("not an object"), undefined);
  });

  it("reads the labels an update added from the changes block", () => {
    const event = normalized(
      issueHook("update", {
        labels: [{ title: "bug" }, { title: "ready-for-agent" }],
        changes: {
          labels: {
            previous: [{ title: "bug" }],
            current: [{ title: "bug" }, { title: "ready-for-agent" }],
          },
        },
      }),
    );
    assert.equal(event.type, "issue");
    assert.deepEqual(event.type === "issue" && event.addedLabels, ["ready-for-agent"]);
    assert.deepEqual(event.type === "issue" && event.item.labels, ["bug", "ready-for-agent"]);
    assert.equal(classifyGitlabEvent(event).semanticEvent, "gitlab.issue_label_added");
    assert.equal(classifyGitlabEvent(normalized(issueHook("update"))).semanticEvent, undefined);
  });

  it("classifies opened merge requests and joins title and description as the text", () => {
    const event = normalized(mergeRequestHook("open"));
    const classified = classifyGitlabEvent(event);
    assert.equal(classified.semanticEvent, "gitlab.merge_request_created");
    assert.equal(classified.text, "Ship the feature\nUseful context");
    assert.equal(classified.actor, "alice");
    assert.equal(
      classifyGitlabEvent(normalized(mergeRequestHook("merge"))).semanticEvent,
      undefined,
    );
  });

  it("normalizes a push with its ref and commit count", () => {
    const event = normalized(pushHook());
    assert.deepEqual(event, {
      type: "push",
      project: PROJECT,
      user: { id: 7, username: "alice", name: "Alice" },
      push: {
        ref: "refs/heads/main",
        before: "95790bf891e76fee5e1747ab589903a6a1f80f22",
        after: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
        checkoutSha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
        commits: 4,
      },
    });
    assert.equal(classifyGitlabEvent(event).item, null);
  });
});

function normalized(payload: unknown): NormalizedGitlabEvent {
  const event = normalizeGitlabEvent(payload);
  if (event === undefined) throw new Error("payload did not normalize");
  return event;
}
