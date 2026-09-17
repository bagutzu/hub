import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { GitlabProjectInput, ProviderEventAcceptance } from "../../db/types.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import { logger } from "../../logger.js";
import { logProviderEventIntake } from "../audit.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import { gitlabEventSource, normalizeGitlabEvent, type NormalizedGitlabEvent } from "./events.js";

const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_HEADER_LENGTH = 256;
const MAX_TIMESTAMP_SKEW_SECONDS = 300;
const SIGNING_TOKEN_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1,";

/** What a delivery is stored as: the event, under the namespace whose connection accepted it. */
export interface AcceptedGitlabEvent {
  namespaceId: number;
  event: NormalizedGitlabEvent;
}

export interface GitlabWebhookSourceOptions {
  now?: () => number;
  /** The connection whose namespace covers the project, which records the project under it. */
  recordProject(project: GitlabProjectInput): Promise<{ namespaceId: number } | undefined>;
  accept(input: {
    namespaceId: number;
    projectId: number;
    deliveryId: string;
    signatureHash: string;
    source: string;
    repo: string;
    payload: AcceptedGitlabEvent;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

export interface GitlabWebhookEndpoint extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

interface VerifiedGitlabRequest {
  deliveryId: string;
  payload: unknown;
  signatureHash: string;
  receivedAt: Date;
}

/**
 * @param signingToken the `whsec_` token every project hook is registered with, or `undefined`
 * when event triggers are not set up. Without one there is nothing to check a signature against,
 * so every delivery is refused rather than trusted.
 */
export function createGitlabWebhookSource(
  signingToken: string | undefined,
  options: GitlabWebhookSourceOptions,
): GitlabWebhookEndpoint {
  const handlers = new Set<TriggerHandler>();
  const key = signingToken === undefined ? undefined : signingKey(signingToken);
  return {
    async handle(request) {
      if (key === undefined) {
        logger.warn("rejecting GitLab event because no signing token is configured");
        return new Response("Service Unavailable", { status: 503 });
      }
      const verified = await verifyGitlabRequest(request, key, options.now);
      if (verified instanceof Response) return verified;
      return handoffGitlabEvent(verified, handlers, options);
    },
    async start(handler) {
      handlers.add(handler);
    },
    async stop() {
      handlers.clear();
    },
  };
}

async function verifyGitlabRequest(
  request: Request,
  key: Buffer,
  now: (() => number) | undefined,
): Promise<VerifiedGitlabRequest | Response> {
  const deliveryId = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (
    deliveryId === null ||
    timestamp === null ||
    signature === null ||
    deliveryId.length === 0 ||
    deliveryId.length > MAX_HEADER_LENGTH
  ) {
    logger.warn("rejecting GitLab event because signature evidence is missing");
    return new Response("Unauthorized", { status: 401 });
  }
  const receivedAt = new Date(now?.() ?? Date.now());
  if (!verifyGitlabWebhookTimestamp(timestamp, receivedAt.getTime())) {
    logger.warn("rejecting GitLab event because its signed timestamp is stale or invalid");
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (body instanceof Response) return body;
  const matched = verifyGitlabSignature(key, deliveryId, timestamp, body, signature);
  if (matched === undefined) {
    logger.warn("rejecting GitLab event because signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    logger.warn("rejecting GitLab event because payload is invalid JSON");
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  return {
    deliveryId,
    payload,
    signatureHash: createHash("sha256").update(matched).digest("hex"),
    receivedAt,
  };
}

async function handoffGitlabEvent(
  verified: VerifiedGitlabRequest,
  handlers: Set<TriggerHandler>,
  options: GitlabWebhookSourceOptions,
): Promise<Response> {
  const event = normalizeGitlabEvent(verified.payload);
  if (event === undefined) {
    logger.info({ deliveryId: verified.deliveryId }, "ignoring unsupported GitLab event");
    return new Response("OK", { status: 200 });
  }
  const source = gitlabEventSource(event);
  try {
    const connection = await options.recordProject({
      projectId: event.project.id,
      pathWithNamespace: event.project.pathWithNamespace,
      defaultBranch: event.project.defaultBranch,
      webUrl: event.project.webUrl,
    });
    const acceptance: ProviderEventAcceptance =
      connection === undefined
        ? { status: "dropped", receiptId: verified.deliveryId, reason: "gitlab_unbound" }
        : await options.accept({
            namespaceId: connection.namespaceId,
            projectId: event.project.id,
            deliveryId: verified.deliveryId,
            signatureHash: verified.signatureHash,
            source,
            repo: event.project.pathWithNamespace,
            payload: { namespaceId: connection.namespaceId, event },
            receivedAt: verified.receivedAt,
            ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
          });
    logProviderEventIntake({
      provider: "gitlab",
      source,
      deliveryId: verified.deliveryId,
      repository: event.project.pathWithNamespace,
      resourceId: String(event.project.id),
      acceptance,
    });
    const events = acceptance.status === "accepted" ? acceptance.events : [];
    await Promise.all(
      events.flatMap((accepted) => Array.from(handlers, (handler) => handler(accepted))),
    );
    return new Response("OK", { status: 200 });
  } catch (error) {
    logger.error({ err: error, deliveryId: verified.deliveryId }, "GitLab event handoff failed");
    return Response.json({ error: "event_handoff_unavailable" }, { status: 503 });
  }
}

/** The key GitLab signs with: the base64 after `whsec_`, or the token's own bytes without it. */
export function signingKey(signingToken: string): Buffer {
  return signingToken.startsWith(SIGNING_TOKEN_PREFIX)
    ? Buffer.from(signingToken.slice(SIGNING_TOKEN_PREFIX.length), "base64")
    : Buffer.from(signingToken, "utf8");
}

/**
 * GitLab signs `"{id}.{timestamp}.{body}"` with HMAC-SHA256 and sends `v1,<base64>`; several
 * space-separated signatures may be present while a token rotates. Answers the signature bytes
 * that matched, which are the canonical evidence to dedupe on, or undefined.
 */
export function verifyGitlabSignature(
  key: Buffer,
  deliveryId: string,
  timestamp: string,
  body: Uint8Array,
  signatureHeader: string,
): Buffer | undefined {
  const expected = createHmac("sha256", key)
    .update(`${deliveryId}.${timestamp}.`)
    .update(body)
    .digest();
  for (const candidate of signatureHeader.split(" ")) {
    if (!candidate.startsWith(SIGNATURE_VERSION)) continue;
    const actual = Buffer.from(candidate.slice(SIGNATURE_VERSION.length), "base64");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return actual;
  }
  return undefined;
}

/** The timestamp is inside the signed material, so it can safely bound replay. */
export function verifyGitlabWebhookTimestamp(
  timestamp: string,
  nowMilliseconds = Date.now(),
): boolean {
  if (!/^\d{1,12}$/u.test(timestamp)) return false;
  const seconds = Number(timestamp);
  return Math.abs(nowMilliseconds / 1_000 - seconds) <= MAX_TIMESTAMP_SKEW_SECONDS;
}
