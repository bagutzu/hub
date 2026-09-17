import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "vitest";
import type { DurableProviderEvent, ProviderEventAcceptance } from "../../db/types.js";
import { issueHook, noteHook } from "../../test-utils/gitlab-hooks.js";
import {
  createGitlabWebhookSource,
  signingKey,
  verifyGitlabSignature,
  verifyGitlabWebhookTimestamp,
  type GitlabWebhookSourceOptions,
} from "./webhook.js";

type AcceptInput = Parameters<GitlabWebhookSourceOptions["accept"]>[0];

const KEY = Buffer.from("webhook-secret");
const TOKEN = `whsec_${KEY.toString("base64")}`;
const NOW = 1_700_000_000_000;
const TIMESTAMP = String(NOW / 1_000);

describe("GitLab webhook", () => {
  it("verifies the id, timestamp and raw body under any of the listed v1 signatures", () => {
    const body = new TextEncoder().encode('{"title":"héllo"}');
    const good = sign("delivery-1", TIMESTAMP, body);
    assert.deepEqual(
      verifyGitlabSignature(KEY, "delivery-1", TIMESTAMP, body, good),
      signatureBytes(good),
    );
    assert.deepEqual(
      verifyGitlabSignature(KEY, "delivery-1", TIMESTAMP, body, `v1,AAAA ${good}`),
      signatureBytes(good),
    );
    assert.equal(verifyGitlabSignature(KEY, "delivery-2", TIMESTAMP, body, good), undefined);
    assert.equal(verifyGitlabSignature(KEY, "delivery-1", "1", body, good), undefined);
    assert.equal(verifyGitlabSignature(KEY, "delivery-1", TIMESTAMP, body, "v0,AAAA"), undefined);
    assert.deepEqual(signingKey(TOKEN), KEY);
    assert.deepEqual(signingKey("plain"), Buffer.from("plain"));
    assert.equal(verifyGitlabWebhookTimestamp(TIMESTAMP, NOW), true);
    assert.equal(verifyGitlabWebhookTimestamp(String(NOW / 1_000 - 301), NOW), false);
    assert.equal(verifyGitlabWebhookTimestamp("soon", NOW), false);
  });

  it("normalizes a note, records its project, durably accepts it and dispatches its route", async () => {
    const accepted: AcceptInput[] = [];
    const recorded: unknown[] = [];
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = createGitlabWebhookSource(TOKEN, {
      now: () => NOW,
      recordProject: async (project) => {
        recorded.push(project);
        return { namespaceId: 42 };
      },
      accept: async (input) => {
        accepted.push(input);
        return acceptedEvent(input);
      },
    });
    await endpoint.start(async (event) => {
      dispatched.push(event);
    });

    const response = await endpoint.handle(request(noteHook()));
    assert.equal(response.status, 200);
    assert.deepEqual(recorded, [
      {
        projectId: 4201,
        pathWithNamespace: "acme/api",
        defaultBranch: "main",
        webUrl: "https://gitlab.com/acme/api",
      },
    ]);
    assert.equal(accepted.length, 1);
    const input = accepted[0];
    if (input === undefined) throw new Error("expected an accepted input");
    assert.equal(input.namespaceId, 42);
    assert.equal(input.projectId, 4201);
    assert.equal(input.deliveryId, "delivery-1");
    assert.equal(input.source, "gitlab.note");
    assert.equal(input.repo, "acme/api");
    assert.equal(input.dropReason, undefined);
    assert.equal(
      input.signatureHash,
      sha256(signatureBytes(sign("delivery-1", TIMESTAMP, JSON.stringify(noteHook())))),
    );
    assert.deepEqual(input.receivedAt, new Date(NOW));
    assert.equal(input.payload.namespaceId, 42);
    assert.equal(input.payload.event.type, "note");
    assert.deepEqual(
      dispatched.map(({ source, resourceId }) => ({ source, resourceId })),
      [{ source: "gitlab.note", resourceId: "4201" }],
    );
  });

  it("drops a delivery for a project no connection covers without storing it", async () => {
    let accepted = false;
    const endpoint = createGitlabWebhookSource(TOKEN, {
      now: () => NOW,
      recordProject: async () => undefined,
      accept: async () => {
        accepted = true;
        return { status: "duplicate", receiptId: "x" };
      },
    });
    assert.equal((await endpoint.handle(request(issueHook("open")))).status, 200);
    assert.equal(accepted, false);
  });

  it("records a durable outcome when a bound delivery has no handler", async () => {
    const reasons: (string | undefined)[] = [];
    const endpoint = createGitlabWebhookSource(TOKEN, {
      now: () => NOW,
      recordProject: async () => ({ namespaceId: 42 }),
      accept: async (input) => {
        reasons.push(input.dropReason);
        return { status: "dropped", receiptId: input.deliveryId, reason: input.dropReason! };
      },
    });
    assert.equal((await endpoint.handle(request(issueHook("open")))).status, 200);
    assert.deepEqual(reasons, ["configuration_unavailable"]);
  });

  it("acknowledges unsupported hooks without recording anything", async () => {
    let touched = false;
    const endpoint = createGitlabWebhookSource(TOKEN, {
      now: () => NOW,
      recordProject: async () => {
        touched = true;
        return undefined;
      },
      accept: async () => {
        touched = true;
        return { status: "duplicate", receiptId: "x" };
      },
    });
    assert.equal((await endpoint.handle(request({ object_kind: "pipeline" }))).status, 200);
    assert.equal((await endpoint.handle(request(noteHook({ noteable: "Commit" })))).status, 200);
    assert.equal(touched, false);
  });

  it("refuses unsigned, stale, tampered, unconfigured and unavailable handoffs", async () => {
    const endpoint = createGitlabWebhookSource(TOKEN, {
      now: () => NOW,
      recordProject: () => Promise.reject(new Error("database offline")),
      accept: () => Promise.reject(new Error("database offline")),
    });
    const unsigned = new Request("https://hub.test/api/integrations/gitlab/events", {
      method: "POST",
      body: JSON.stringify(noteHook()),
    });
    assert.equal((await endpoint.handle(unsigned)).status, 401);
    assert.equal(
      (await endpoint.handle(request(noteHook(), { timestamp: String(NOW / 1_000 - 600) }))).status,
      401,
    );
    assert.equal(
      (await endpoint.handle(request(noteHook(), { signature: sign("other", TIMESTAMP, "{}") })))
        .status,
      401,
    );
    assert.equal((await endpoint.handle(request("not json"))).status, 400);
    assert.equal((await endpoint.handle(request(noteHook()))).status, 503);

    const unconfigured = createGitlabWebhookSource(undefined, {
      recordProject: () => Promise.reject(new Error("unused")),
      accept: () => Promise.reject(new Error("unused")),
    });
    assert.equal((await unconfigured.handle(request(noteHook()))).status, 503);
  });
});

function request(
  payload: unknown,
  evidence: { deliveryId?: string; timestamp?: string; signature?: string } = {},
): Request {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const deliveryId = evidence.deliveryId ?? "delivery-1";
  const timestamp = evidence.timestamp ?? TIMESTAMP;
  return new Request("https://hub.test/api/integrations/gitlab/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": "Note Hook",
      "webhook-id": deliveryId,
      "webhook-timestamp": timestamp,
      "webhook-signature": evidence.signature ?? sign(deliveryId, timestamp, body),
    },
    body,
  });
}

function sign(deliveryId: string, timestamp: string, body: string | Uint8Array): string {
  const digest = createHmac("sha256", KEY)
    .update(`${deliveryId}.${timestamp}.`)
    .update(body)
    .digest("base64");
  return `v1,${digest}`;
}

function signatureBytes(signature: string): Buffer {
  return Buffer.from(signature.slice("v1,".length), "base64");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function acceptedEvent(input: AcceptInput): ProviderEventAcceptance {
  return {
    status: "accepted",
    receiptId: "receipt-1",
    events: [
      {
        providerEventReceiptId: "receipt-1",
        organizationId: "org-1",
        projectId: "hub-project-1",
        configurationRevisionId: "11111111-1111-4111-8111-111111111132",
        deliveryId: input.deliveryId,
        source: input.source,
        payload: input.payload,
        receivedAt: input.receivedAt,
        connectionId: "gitlab-connection",
        resourceId: String(input.projectId),
      },
    ],
  };
}
