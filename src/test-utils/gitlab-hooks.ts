/** GitLab webhook payloads shaped like the documented examples, trimmed to what Hub reads. */
export const PROJECT_RAW = {
  id: 4201,
  name: "api",
  path_with_namespace: "acme/api",
  web_url: "https://gitlab.com/acme/api",
  default_branch: "main",
  namespace: "acme",
};

export const PROJECT = {
  id: 4201,
  pathWithNamespace: "acme/api",
  webUrl: "https://gitlab.com/acme/api",
  defaultBranch: "main",
};

const USER = { id: 7, username: "alice", name: "Alice", avatar_url: null, email: "[REDACTED]" };

export function noteHook(
  options: { noteable?: "Issue" | "MergeRequest" | "Commit"; body?: string } = {},
) {
  const noteable = options.noteable ?? "Issue";
  const item = {
    id: 92,
    iid: 17,
    title: "Ship the feature",
    description: "Useful context",
    state: "opened",
    labels: [{ id: 1, title: "bug", color: "#d9534f" }],
  };
  return {
    object_kind: "note",
    event_type: "note",
    user: USER,
    project_id: 4201,
    project: PROJECT_RAW,
    object_attributes: {
      id: 1241,
      note: options.body ?? "@paseo please take a look",
      noteable_type: noteable,
      noteable_id: 92,
      author_id: 7,
      url: `https://gitlab.com/acme/api/-/${noteable === "MergeRequest" ? "merge_requests" : "issues"}/17#note_1241`,
    },
    ...(noteable === "Issue" ? { issue: item } : {}),
    ...(noteable === "MergeRequest" ? { merge_request: { ...item, source_branch: "topic" } } : {}),
    ...(noteable === "Commit" ? { commit: { id: "da15608" } } : {}),
  };
}

export function issueHook(action: string, overrides: Record<string, unknown> = {}) {
  return {
    object_kind: "issue",
    event_type: "issue",
    user: USER,
    project: PROJECT_RAW,
    object_attributes: {
      id: 92,
      iid: 17,
      title: "Ship the feature",
      description: "Useful context",
      state: "opened",
      action,
      confidential: false,
      url: "https://gitlab.com/acme/api/-/issues/17",
      labels: [{ id: 1, title: "bug" }],
    },
    labels: [{ id: 1, title: "bug" }],
    changes: {},
    ...overrides,
  };
}

export function mergeRequestHook(action: string, overrides: Record<string, unknown> = {}) {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: USER,
    project: PROJECT_RAW,
    object_attributes: {
      id: 99,
      iid: 17,
      title: "Ship the feature",
      description: "Useful context",
      state: "opened",
      action,
      source_branch: "topic",
      target_branch: "main",
      url: "https://gitlab.com/acme/api/-/merge_requests/17",
      labels: [],
    },
    labels: [],
    changes: {},
    ...overrides,
  };
}

export function pushHook() {
  return {
    object_kind: "push",
    event_name: "push",
    before: "95790bf891e76fee5e1747ab589903a6a1f80f22",
    after: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
    ref: "refs/heads/main",
    checkout_sha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
    user_id: 7,
    user_name: "Alice",
    user_username: "alice",
    project_id: 4201,
    project: PROJECT_RAW,
    commits: [{ id: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7" }],
    total_commits_count: 4,
  };
}
