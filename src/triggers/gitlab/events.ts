import { z } from "zod";

export const GITLAB_TRIGGER_SOURCE_NAMES = [
  "gitlab.issue",
  "gitlab.merge_request",
  "gitlab.note",
  "gitlab.push",
] as const;

export type GitlabTriggerSource = (typeof GITLAB_TRIGGER_SOURCE_NAMES)[number];

export const GITLAB_SEMANTIC_TRIGGER_EVENT_NAMES = [
  "gitlab.issue_created",
  "gitlab.merge_request_created",
  "gitlab.issue_comment_created",
  "gitlab.merge_request_comment_created",
  "gitlab.issue_label_added",
  "gitlab.merge_request_label_added",
] as const;

export type GitlabSemanticEvent = (typeof GITLAB_SEMANTIC_TRIGGER_EVENT_NAMES)[number];

const GitlabProjectSchema = z.object({
  id: z.number().int().positive(),
  pathWithNamespace: z.string().min(1),
  webUrl: z.string().url(),
  defaultBranch: z.string().min(1).nullable(),
});

const GitlabActorSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(1),
  name: z.string(),
});

const GitlabItemSchema = z.object({
  type: z.enum(["issue", "merge_request"]),
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string().url(),
  labels: z.array(z.string()),
  confidential: z.boolean(),
});

export const NormalizedGitlabItemEventSchema = z.object({
  type: z.enum(["issue", "merge_request"]),
  action: z.string().nullable(),
  project: GitlabProjectSchema,
  user: GitlabActorSchema.nullable(),
  item: GitlabItemSchema,
  addedLabels: z.array(z.string()),
});

export const NormalizedGitlabNoteEventSchema = z.object({
  type: z.literal("note"),
  project: GitlabProjectSchema,
  user: GitlabActorSchema.nullable(),
  note: z.object({ id: z.number().int().positive(), body: z.string(), url: z.string().url() }),
  item: GitlabItemSchema,
});

export const NormalizedGitlabPushEventSchema = z.object({
  type: z.literal("push"),
  project: GitlabProjectSchema,
  user: GitlabActorSchema.nullable(),
  push: z.object({
    ref: z.string().min(1),
    before: z.string(),
    after: z.string(),
    checkoutSha: z.string().nullable(),
    commits: z.number().int().nonnegative(),
  }),
});

export const NormalizedGitlabEventSchema = z.discriminatedUnion("type", [
  NormalizedGitlabItemEventSchema,
  NormalizedGitlabNoteEventSchema,
  NormalizedGitlabPushEventSchema,
]);

export type NormalizedGitlabProject = z.infer<typeof GitlabProjectSchema>;
export type NormalizedGitlabItem = z.infer<typeof GitlabItemSchema>;
export type NormalizedGitlabItemEvent = z.infer<typeof NormalizedGitlabItemEventSchema>;
export type NormalizedGitlabNoteEvent = z.infer<typeof NormalizedGitlabNoteEventSchema>;
export type NormalizedGitlabPushEvent = z.infer<typeof NormalizedGitlabPushEventSchema>;
export type NormalizedGitlabEvent = z.infer<typeof NormalizedGitlabEventSchema>;

const RawProjectSchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string().min(1),
  web_url: z.string().url(),
  default_branch: z.string().min(1).nullable().optional(),
});
const RawUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(1),
  name: z.string().optional(),
});
const RawLabelsSchema = z.array(z.object({ title: z.string() })).optional();
const RawItemSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  labels: RawLabelsSchema,
  confidential: z.boolean().optional(),
});
const RawItemEventSchema = z.object({
  object_kind: z.enum(["issue", "merge_request"]),
  event_type: z.string().optional(),
  user: RawUserSchema.optional(),
  project: RawProjectSchema,
  object_attributes: RawItemSchema.extend({ action: z.string().optional() }),
  labels: RawLabelsSchema,
  changes: z
    .object({
      labels: z.object({ previous: RawLabelsSchema, current: RawLabelsSchema }).optional(),
    })
    .optional(),
});
const RawNoteEventSchema = z.object({
  object_kind: z.literal("note"),
  event_type: z.string().optional(),
  user: RawUserSchema.optional(),
  project: RawProjectSchema,
  object_attributes: z.object({
    id: z.number().int().positive(),
    note: z.string(),
    noteable_type: z.string(),
    url: z.string().url(),
  }),
  issue: RawItemSchema.optional(),
  merge_request: RawItemSchema.optional(),
});
const RawPushEventSchema = z.object({
  object_kind: z.literal("push"),
  user_id: z.number().int().positive().optional(),
  user_username: z.string().min(1).optional(),
  user_name: z.string().optional(),
  project: RawProjectSchema,
  ref: z.string().min(1),
  before: z.string(),
  after: z.string(),
  checkout_sha: z.string().nullable().optional(),
  total_commits_count: z.number().int().nonnegative().optional(),
  commits: z.array(z.unknown()).optional(),
});

/**
 * GitLab's hook payloads are keyed by `object_kind`; the `X-Gitlab-Event` header only restates
 * it. A note on anything but an issue or merge request has no thread an agent could answer on,
 * so it is not an event.
 */
export function normalizeGitlabEvent(payload: unknown): NormalizedGitlabEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const kind = payload["object_kind"];
  if (kind === "issue" || kind === "merge_request") return normalizeItemEvent(payload);
  if (kind === "note") return normalizeNoteEvent(payload);
  if (kind === "push") return normalizePushEvent(payload);
  return undefined;
}

export function gitlabEventSource(event: NormalizedGitlabEvent): GitlabTriggerSource {
  return `gitlab.${event.type}`;
}

export interface GitlabClassifiedEvent {
  readonly semanticEvent: GitlabSemanticEvent | undefined;
  readonly actor: string;
  readonly text: string;
  readonly labels: readonly string[];
  readonly addedLabels: readonly string[];
  readonly item: NormalizedGitlabItem | null;
}

/** The sole owner of GitLab action and item interpretation. */
export function classifyGitlabEvent(event: NormalizedGitlabEvent): GitlabClassifiedEvent {
  const actor = event.user?.username ?? "";
  if (event.type === "push") {
    return { semanticEvent: undefined, actor, text: "", labels: [], addedLabels: [], item: null };
  }
  if (event.type === "note") {
    return {
      semanticEvent:
        event.item.type === "issue"
          ? "gitlab.issue_comment_created"
          : "gitlab.merge_request_comment_created",
      actor,
      text: event.note.body,
      labels: event.item.labels,
      addedLabels: [],
      item: event.item,
    };
  }
  return {
    semanticEvent: itemSemanticEvent(event),
    actor,
    text: [event.item.title, event.item.description ?? ""]
      .filter((value) => value.length > 0)
      .join("\n"),
    labels: event.item.labels,
    addedLabels: event.addedLabels,
    item: event.item,
  };
}

function itemSemanticEvent(event: NormalizedGitlabItemEvent): GitlabSemanticEvent | undefined {
  if (event.action === "open") {
    return event.type === "issue" ? "gitlab.issue_created" : "gitlab.merge_request_created";
  }
  if (event.action === "update" && event.addedLabels.length > 0) {
    return event.type === "issue" ? "gitlab.issue_label_added" : "gitlab.merge_request_label_added";
  }
  return undefined;
}

function normalizeItemEvent(payload: Record<string, unknown>): NormalizedGitlabEvent | undefined {
  const parsed = RawItemEventSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const raw = parsed.data;
  const type = raw.object_kind;
  const previous = new Set(labelTitles(raw.changes?.labels?.previous));
  const current = labelTitles(
    raw.changes?.labels?.current ?? raw.labels ?? raw.object_attributes.labels,
  );
  return {
    type,
    action: raw.object_attributes.action ?? null,
    project: normalizeProject(raw.project),
    user: normalizeUser(raw.user),
    item: normalizeItem(type, raw.object_attributes, raw.project, {
      labels: current,
      confidential: raw.event_type === "confidential_issue",
    }),
    addedLabels:
      raw.changes?.labels === undefined ? [] : current.filter((label) => !previous.has(label)),
  };
}

function normalizeNoteEvent(payload: Record<string, unknown>): NormalizedGitlabEvent | undefined {
  const parsed = RawNoteEventSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const raw = parsed.data;
  const noteable = noteableItem(raw);
  if (noteable === undefined) return undefined;
  const { type, item: rawItem } = noteable;
  return {
    type: "note",
    project: normalizeProject(raw.project),
    user: normalizeUser(raw.user),
    note: {
      id: raw.object_attributes.id,
      body: raw.object_attributes.note,
      url: raw.object_attributes.url,
    },
    item: normalizeItem(type, rawItem, raw.project, {
      labels: labelTitles(rawItem.labels),
      confidential: raw.event_type === "confidential_note",
    }),
  };
}

function noteableItem(
  raw: z.infer<typeof RawNoteEventSchema>,
): { type: NormalizedGitlabItem["type"]; item: z.infer<typeof RawItemSchema> } | undefined {
  const noteable = raw.object_attributes.noteable_type;
  if (noteable === "Issue" && raw.issue !== undefined) return { type: "issue", item: raw.issue };
  if (noteable === "MergeRequest" && raw.merge_request !== undefined) {
    return { type: "merge_request", item: raw.merge_request };
  }
  return undefined;
}

function normalizePushEvent(payload: Record<string, unknown>): NormalizedGitlabEvent | undefined {
  const parsed = RawPushEventSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const raw = parsed.data;
  return {
    type: "push",
    project: normalizeProject(raw.project),
    user:
      raw.user_id === undefined || raw.user_username === undefined
        ? null
        : { id: raw.user_id, username: raw.user_username, name: raw.user_name ?? "" },
    push: {
      ref: raw.ref,
      before: raw.before,
      after: raw.after,
      checkoutSha: raw.checkout_sha ?? null,
      commits: raw.total_commits_count ?? raw.commits?.length ?? 0,
    },
  };
}

function normalizeProject(raw: z.infer<typeof RawProjectSchema>): NormalizedGitlabProject {
  return {
    id: raw.id,
    pathWithNamespace: raw.path_with_namespace,
    webUrl: raw.web_url,
    defaultBranch: raw.default_branch ?? null,
  };
}

function normalizeUser(
  raw: z.infer<typeof RawUserSchema> | undefined,
): NormalizedGitlabEvent["user"] {
  return raw === undefined ? null : { id: raw.id, username: raw.username, name: raw.name ?? "" };
}

function normalizeItem(
  type: NormalizedGitlabItem["type"],
  raw: z.infer<typeof RawItemSchema>,
  project: z.infer<typeof RawProjectSchema>,
  read: { labels: string[]; confidential: boolean },
): NormalizedGitlabItem {
  return {
    type,
    iid: raw.iid,
    title: raw.title,
    description: raw.description ?? null,
    url: `${project.web_url}/-/${type === "issue" ? "issues" : "merge_requests"}/${String(raw.iid)}`,
    labels: read.labels,
    confidential: read.confidential || raw.confidential === true,
  };
}

function labelTitles(labels: z.infer<typeof RawLabelsSchema>): string[] {
  return labels?.map((label) => label.title) ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
