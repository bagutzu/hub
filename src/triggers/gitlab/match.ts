import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import {
  classifyGitlabEvent,
  gitlabEventSource,
  type GitlabClassifiedEvent,
  type NormalizedGitlabEvent,
} from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedGitlabTrigger {
  event: NormalizedGitlabEvent;
  trigger: MatchedTriggerDefinition;
}

export function readGitlabInvocationMessage(event: NormalizedGitlabEvent): string {
  return classifyGitlabEvent(event).text;
}

export function readGitlabInvocationParserMessage(
  event: NormalizedGitlabEvent,
  filter: TriggerFilter | undefined,
): string {
  const message = readGitlabInvocationMessage(event);
  const contains = filter === undefined ? undefined : readStringFilter(filter, "contains");
  if (contains === undefined) return message;
  const index = message.indexOf(contains);
  return index === -1 ? message : message.slice(index);
}

export function readGitlabMention(
  event: NormalizedGitlabEvent,
  filter: TriggerFilter | undefined,
): string | undefined {
  const message = readGitlabInvocationMessage(event);
  const candidate = filter?.pattern ?? filter?.contains;
  return candidate !== undefined && message.includes(candidate) ? candidate : undefined;
}

/** GitHub's filter semantics on GitLab's vocabulary: fail closed without an allowlist. */
export function matchGitlabTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitlabEvent,
  connectionId?: string | null,
): MatchedGitlabTrigger[] {
  const classified = classifyGitlabEvent(event);
  const eventNames = new Set<string | undefined>([
    gitlabEventSource(event),
    classified.semanticEvent,
  ]);
  return config.triggers.flatMap((trigger) =>
    eventNames.has(trigger.on) && matchesFilter(classified, trigger.filters, event, connectionId)
      ? [{ event, trigger }]
      : [],
  );
}

function matchesFilter(
  classified: GitlabClassifiedEvent,
  filter: TriggerFilter | undefined,
  event: NormalizedGitlabEvent,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) return false;
  if (filter.from_users === undefined || filter.from_users.length === 0) return false;
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;
  const project = filter["project"];
  if (typeof project === "string" && project !== event.project.pathWithNamespace) return false;
  const resourceId = filter["resourceId"];
  if (typeof resourceId === "string" && resourceId !== String(event.project.id)) return false;
  const pattern = readStringFilter(filter, "pattern");
  if (pattern !== undefined && !classified.text.startsWith(pattern)) return false;
  const contains = readStringFilter(filter, "contains");
  if (contains !== undefined && !classified.text.includes(contains)) return false;
  if (!filter.from_users.includes("*") && !filter.from_users.includes(classified.actor)) {
    return false;
  }
  const label = readStringFilter(filter, "label");
  if (label !== undefined && !classified.addedLabels.some((added) => sameLabel(label, added))) {
    return false;
  }
  const labels = filter.labels;
  if (
    labels !== undefined &&
    !labels.every((labelName) => classified.labels.some((current) => sameLabel(labelName, current)))
  ) {
    return false;
  }
  return true;
}

function readStringFilter(
  filter: TriggerFilter,
  key: "pattern" | "contains" | "label",
): string | undefined {
  const value = filter[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameLabel(expected: string, actual: string): boolean {
  return expected.localeCompare(actual, undefined, { sensitivity: "accent" }) === 0;
}
