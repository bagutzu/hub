# Workflow step authority

Workflow authority is authored on an individual step. It is not a trigger option,
agent option, sandbox setting, or Paseo daemon feature.

## Generic connection values

Step environment values may explicitly request a named value from a configured
connection:

```yaml
env:
  SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

The expression shape is exactly
`${{ paseo.connections.<connection-slug>.<named-value> }}`. Hub resolves it while
materializing the selected step, after the project and organization connection
have been verified. The authored expression, not its resolved value, is retained
in configuration and durable launch data. Resolved values are not placed in logs
or diagnostics. This works for manual, Discord, Slack, GitHub, GitLab, and Linear
trigger events.

## GitHub authority

GitHub authority is opt-in and step-scoped:

```yaml
github:
  connection: getpaseo-github
  repositories:
    - getpaseo/paseo
  permissions:
    contents: write
    pull_requests: write
    issues: read
  duration: 1h
```

`connection` is the configured connection slug. It must be active and belong to
the execution project's organization. `repositories` uses GitHub's repository
scope and accepts full `owner/name` values whose owner must match the selected
connection account login case-insensitively. For non-GitHub triggers it is required;
Hub never expands an omitted list to every repository in an installation. For a
GitHub event only, omitting it deterministically scopes the token to that event's
repository. An explicit list is recommended when the step is invoked by more than
one source. Hub validates the full names for the authored contract and passes the
repository names in GitHub's native installation-token request format.

`permissions` uses GitHub App installation-token permission names and levels
directly. It defaults to `{ contents: read }`. Hub validates against its explicitly
versioned copy of GitHub REST API version `2026-03-10`; unsupported names or levels
fail configuration activation with a path to the offending field. Hub forwards only
the authored repository and permission restrictions to GitHub.

`duration` defaults to `1h`, matching GitHub's fixed installation-token lifetime.
Positive shorter durations are supported; Hub revokes the token at the lease
deadline and always revokes it when the execution reaches a terminal state.
Durations above `1h` are rejected.

If the block is absent, Hub does not mint a GitHub token and does not add
`GH_TOKEN` or Git environment variables, regardless of the trigger provider.
When present, the selected step receives only ordinary environment variables:

- `GH_TOKEN` with the fresh restricted installation token;
- indexed `GIT_CONFIG_*` entries for the bot identity, HTTPS rewriting of both
  supported SSH GitHub URL forms, and `!gh auth git-credential`;
- `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and
  `GIT_TERMINAL_PROMPT=0`.

The bot identity is resolved from `GET /users/{app-slug}[bot]` and cached at the
application level. GitHub's returned bot user ID and login form the identity
`{bot-user-id}+{bot-login}@users.noreply.github.com`.

The reserved Git environment keys cannot be authored alongside a `github` block;
activation fails instead of making precedence order observable. Authority is
materialized independently for each running step. Classifier and skipped steps do
not receive it, and no Git-specific RPC field is sent to Paseo.

## GitLab authority

GitLab authority is opt-in and step-scoped, and it takes the connection alone:

```yaml
gitlab:
  connection: acme-gitlab
```

There is no `repositories`, no `permissions` and no `duration`, because a GitLab OAuth grant
cannot be narrowed: it carries the `api` scope of the user who connected the group. A key
that looked like a boundary would lie about one. The connection must belong to the execution
project's organization and must not need reauthorization.

The lease is the connection's own access token, the same one Hub uses for reactions and
replies, and every concurrent step on that connection shares it. A GitLab refresh retires the
previous access token as well as the previous refresh token, so minting one per step would cut
the other steps off. Hub refreshes only when the token has expired, and the lease deadline is
the token's real remaining lifetime, never more than GitLab's two hours. A step that outlives
its lease loses GitLab access, the same class of ceiling as GitHub's one hour.

Nothing is revoked when the lease ends: the deadline is the revocation, and the connection's
next refresh retires the token. Hub drops the lease record at the deadline and at execution
termination.

When present, the selected step receives only ordinary environment variables:

- `GITLAB_TOKEN` with the connection's current access token, and `GITLAB_HOST` with the
  instance host, which is what `glab` reads;
- indexed `GIT_CONFIG_*` entries for the grant holder's identity
  (`{user-id}-{username}@users.noreply.{host}`), HTTPS rewriting of both SSH URL forms, and a
  credential helper that answers `oauth2` and reads the token from the environment, so it is
  never written to a file;
- `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and `GIT_TERMINAL_PROMPT=0`.

Those keys cannot be authored alongside a `gitlab` block, and one step cannot carry both
`github` and `gitlab`: they write the same Git configuration variables, and the second would
silently overwrite the first.

Hub persists materialized authority and credential leases before delivering credentials to
an agent. A Hub restart preserves active executions and their original credentials; recovery
reattaches the same agent and restores lease deadlines and pending revocation work. Stopping
the Hub process does not end an execution or revoke its credentials.

Completion, cancellation, and the original lease deadline still require revocation. Recovery
does not mint replacement credentials or extend deadlines. If Hub is unavailable at a shorter
lease deadline, it reconciles overdue revocation when it returns; upstream expiry remains the
maximum token lifetime. Revocation failures remain durable and retry until upstream expiry.

Resolved credentials are private runtime data in the Hub database, separate from authored
configuration. Authority records are removed at execution termination; lease records remain
only until revocation succeeds or the token expires.

When upgrading from a version with process-owned credentials, let active credentialed runs
finish before restarting Hub. That version cannot hand its in-memory leases to the replacement.

Public workflow-authority guidance lives in the Paseo repository under `public-docs/`.
