import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { GitlabApiClient } from "../../providers/gitlab/client.js";

const GitlabReplyArgsSchema = z.object({ content: z.string().min(1) });
const GitlabReplyOutputContextSchema = z.object({
  provider: z.literal("gitlab"),
  target: z.object({
    namespaceId: z.number().int().positive(),
    projectId: z.number().int().positive(),
  }),
  event: z.object({
    gitlab: z.object({
      item: z
        .object({ type: z.enum(["issue", "merge_request"]), iid: z.number().int().positive() })
        .nullable(),
    }),
  }),
});

export function gitlabReplyAvailable(outputContext: unknown): boolean {
  const parsed = GitlabReplyOutputContextSchema.safeParse(outputContext);
  return parsed.success && parsed.data.event.gitlab.item !== null;
}

/** Posts a note on the issue or merge request the run started from. */
export function createGitlabReplyExecutor(options: {
  client: Pick<GitlabApiClient, "createNote">;
}): OutputExecutor {
  return async function executeGitlabReply(input) {
    const args = GitlabReplyArgsSchema.parse(input.args);
    const context = GitlabReplyOutputContextSchema.parse(input.outputContext);
    const item = context.event.gitlab.item;
    if (item === null) throw new Error("GitLab event has no issue or merge request to reply to");
    await options.client.createNote({
      namespaceId: context.target.namespaceId,
      projectId: context.target.projectId,
      item,
      body: args.content,
    });
  };
}
