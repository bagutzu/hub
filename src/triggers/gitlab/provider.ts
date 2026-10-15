import { z } from "zod";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import { reportFailure } from "../../failures/index.js";
import type {
  GitlabApiClient,
  GitlabAwardName,
  GitlabItemRef,
} from "../../providers/gitlab/client.js";
import type { Conversation } from "../continuation.js";
import {
  type TriggerProvider,
  type TriggerProviderMatch,
  type TriggerProviderReactionState,
} from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  GITLAB_TRIGGER_SOURCE_NAMES,
  NormalizedGitlabEventSchema,
  classifyGitlabEvent,
  type NormalizedGitlabEvent,
} from "./events.js";
import {
  matchGitlabTriggers,
  readGitlabInvocationMessage,
  readGitlabInvocationParserMessage,
  readGitlabMention,
} from "./match.js";

const AcceptedGitlabEventSchema = z.object({
  namespaceId: z.number().int().positive(),
  event: NormalizedGitlabEventSchema,
});

export interface GitlabMergeData {
  gitlab: {
    delivery_id: string;
    event_name: string;
    project: { id: number; path_with_namespace: string; web_url: string };
    received_at: string;
    confidential: boolean;
    user: { username: string; name: string } | null;
    item: {
      type: "issue" | "merge_request";
      iid: number;
      title: string;
      description: string | null;
      url: string;
      labels: string[];
    } | null;
    note: { id: number; body: string; url: string } | null;
    push: {
      ref: string;
      before: string;
      after: string;
      checkout_sha: string | null;
      commits: number;
    } | null;
  };
}

/** The item an award lands on, or one of its notes. */
export interface GitlabReactionSubject {
  item: GitlabItemRef;
  noteId: number | null;
}

export interface GitlabTriggerContext {
  provider: "gitlab";
  target: { namespaceId: number; projectId: number };
  event: GitlabMergeData;
  reactionSubject: GitlabReactionSubject | null;
}

interface GitlabReactionState {
  readonly [key: string]: number;
  readonly awardId: number;
}

export type GitlabReactionClient = Pick<GitlabApiClient, "createAward" | "deleteAward">;

export function createGitlabTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  reactions: GitlabReactionClient;
}): TriggerProvider<"gitlab", GitlabTriggerContext> {
  return {
    name: "gitlab",
    eventNames: GITLAB_TRIGGER_SOURCE_NAMES,
    async match(externalTrigger) {
      const { namespaceId, event } = AcceptedGitlabEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      const classified = classifyGitlabEvent(event);
      if (
        !stored.configuration.triggers.some((candidate) =>
          [externalTrigger.source, classified.semanticEvent].includes(candidate.on),
        )
      ) {
        return "no_trigger_for_source";
      }
      const matches: TriggerProviderMatch<GitlabTriggerContext>[] = [];
      for (const match of matchGitlabTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
      )) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined) {
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        }
        const triggerContext: GitlabTriggerContext = {
          provider: "gitlab",
          target: { namespaceId, projectId: event.project.id },
          event: buildGitlabMergeData(
            event,
            externalTrigger.source,
            externalTrigger.deliveryId,
            externalTrigger.receivedAt,
          ),
          reactionSubject: reactionSubjectForEvent(event),
        };
        const invocation = parseInvocation(
          readGitlabInvocationMessage(event),
          compiledTrigger.inputs,
          readGitlabMention(event, compiledTrigger.filters),
          readGitlabInvocationParserMessage(event, compiledTrigger.filters),
        );
        const matched = {
          conversation: gitlabConversation(event),
          triggerName: match.trigger.name,
          triggerContext,
          outputContext: triggerContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
        };
        if (invocation.status === "rejected") {
          matches.push({ ...matched, invocation });
        } else if (matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) {
          matches.push({ ...matched, invocation });
        }
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeContext(launch) {
      return launch.triggerContext.event;
    },
    async onDispatchAccepted(triggerContext, _outputContext, reactionState) {
      if (triggerContext.reactionSubject === null) return null;
      if (gitlabAwardId(reactionState) !== undefined) return reactionState;
      return award(options.reactions, triggerContext, triggerContext.reactionSubject, "eyes");
    },
    async onAgentExecutionCompleted(triggerContext, _outputContext, _result, reactionState) {
      return reactToLifecycle(options.reactions, triggerContext, "thumbsup", reactionState);
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, _reason, reactionState) {
      return reactToLifecycle(options.reactions, triggerContext, "thumbsdown", reactionState);
    },
    async onMachineTerminated(triggerContext, _reason, reactionState) {
      return reactToLifecycle(options.reactions, triggerContext, "thumbsdown", reactionState);
    },
  };
}

function buildGitlabMergeData(
  event: NormalizedGitlabEvent,
  source: string,
  deliveryId: string,
  receivedAt: Date,
): GitlabMergeData {
  const item = event.type === "push" ? null : event.item;
  return {
    gitlab: {
      delivery_id: deliveryId,
      event_name: source,
      project: {
        id: event.project.id,
        path_with_namespace: event.project.pathWithNamespace,
        web_url: event.project.webUrl,
      },
      received_at: receivedAt.toISOString(),
      confidential: item?.confidential ?? false,
      user: event.user === null ? null : { username: event.user.username, name: event.user.name },
      item:
        item === null
          ? null
          : {
              type: item.type,
              iid: item.iid,
              title: item.title,
              description: item.description,
              url: item.url,
              labels: item.labels,
            },
      note: event.type === "note" ? event.note : null,
      push:
        event.type === "push"
          ? {
              ref: event.push.ref,
              before: event.push.before,
              after: event.push.after,
              checkout_sha: event.push.checkoutSha,
              commits: event.push.commits,
            }
          : null,
    },
  };
}

function reactionSubjectForEvent(event: NormalizedGitlabEvent): GitlabReactionSubject | null {
  if (event.type === "push") return null;
  const item = { type: event.item.type, iid: event.item.iid };
  return { item, noteId: event.type === "note" ? event.note.id : null };
}

function gitlabConversation(event: NormalizedGitlabEvent): Conversation | null {
  if (event.type === "push") return null;
  const marker = event.item.type === "issue" ? "#" : "!";
  return {
    key: JSON.stringify(["gitlab", event.project.id, event.item.type, event.item.iid]),
    label: `${event.project.pathWithNamespace}${marker}${String(event.item.iid)}`,
    url: event.item.url,
  };
}

async function award(
  reactions: GitlabReactionClient,
  triggerContext: GitlabTriggerContext,
  subject: GitlabReactionSubject,
  name: GitlabAwardName,
): Promise<GitlabReactionState> {
  const created = await reactions.createAward({
    namespaceId: triggerContext.target.namespaceId,
    projectId: triggerContext.target.projectId,
    item: subject.item,
    noteId: subject.noteId,
    name,
  });
  return { awardId: created.id };
}

async function reactToLifecycle(
  reactions: GitlabReactionClient,
  triggerContext: GitlabTriggerContext,
  name: GitlabAwardName,
  reactionState?: TriggerProviderReactionState,
): Promise<GitlabReactionState | null> {
  const subject = triggerContext.reactionSubject;
  if (subject === null) return null;
  const awardId = gitlabAwardId(reactionState);
  if (awardId !== undefined) {
    try {
      await reactions.deleteAward({
        namespaceId: triggerContext.target.namespaceId,
        projectId: triggerContext.target.projectId,
        item: subject.item,
        noteId: subject.noteId,
        awardId,
      });
    } catch (error) {
      reportFailure(
        error,
        { operation: "gitlab.reaction.cleanup", component: "triggers", provider: "gitlab" },
        { diagnostic: { projectId: triggerContext.target.projectId, awardId } },
      );
    }
  }
  return award(reactions, triggerContext, subject, name);
}

function gitlabAwardId(state: TriggerProviderReactionState | undefined): number | undefined {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return undefined;
  const awardId = state["awardId"];
  return typeof awardId === "number" && Number.isSafeInteger(awardId) ? awardId : undefined;
}
