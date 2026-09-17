import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createGitlabReplyExecutor, gitlabReplyAvailable } from "./reply.js";

describe("GitLab reply output", () => {
  it("posts the workflow outcome as a note on the triggering item", async () => {
    const notes: unknown[] = [];
    const execute = createGitlabReplyExecutor({
      client: {
        createNote: async (input) => {
          notes.push(input);
        },
      },
    });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "gitlab.reply",
      args: { content: "Draft MR: https://gitlab.com/acme/api/-/merge_requests/18" },
      outputContext: context({ type: "merge_request", iid: 17 }),
    });
    assert.deepEqual(notes, [
      {
        namespaceId: 42,
        projectId: 4201,
        item: { type: "merge_request", iid: 17 },
        body: "Draft MR: https://gitlab.com/acme/api/-/merge_requests/18",
      },
    ]);
  });

  it("is unavailable for a push and for another provider's context", async () => {
    assert.equal(gitlabReplyAvailable(context({ type: "issue", iid: 17 })), true);
    assert.equal(gitlabReplyAvailable(context(null)), false);
    assert.equal(gitlabReplyAvailable({ provider: "github" }), false);
    const execute = createGitlabReplyExecutor({
      client: { createNote: () => Promise.reject(new Error("unexpected")) },
    });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "gitlab.reply",
        args: { content: "Done" },
        outputContext: context(null),
      }),
    );
  });
});

function context(item: { type: "issue" | "merge_request"; iid: number } | null) {
  return {
    provider: "gitlab",
    target: { namespaceId: 42, projectId: 4201 },
    event: { gitlab: { item } },
  };
}
