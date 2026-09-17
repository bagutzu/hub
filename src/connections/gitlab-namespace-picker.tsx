/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the server functions are typed through the connections boundary */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState } from "react";
import { Combobox } from "../components/app/combobox.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormField } from "../components/app/form-field.js";
import { Button } from "../components/ui/button.js";
import type { Result } from "../contract/respond.js";
import {
  cancelGitlabConnection,
  gitlabNamespaces,
  selectGitlabNamespace,
  type GitlabNamespaceCandidate,
} from "./functions.js";
import type { ConnectionResult } from "./result-contract.js";

type Settled = Extract<ConnectionResult, "gitlab_connected" | "gitlab_cancelled">;

/**
 * The second leg of a GitLab connection. GitLab has authorized the grant; the operator now says
 * which group or personal namespace the connection covers, from the ones they maintain. Both
 * connection surfaces render it under the GitLab card, so the choice is made where the
 * authorization was started.
 */
export function GitlabNamespacePicker({
  organizationSlug,
  attempt,
  onSettled,
}: {
  organizationSlug: string;
  attempt: string;
  /** Called with the outcome once the attempt is consumed, connected or cancelled. */
  onSettled: (result: Settled) => void;
}) {
  const load = useServerFn(gitlabNamespaces) as (
    input: Parameters<typeof gitlabNamespaces>[0],
  ) => Promise<Result<{ candidates: GitlabNamespaceCandidate[] }>>;
  const candidates = useQuery({
    queryKey: ["gitlab-namespaces", organizationSlug, attempt],
    queryFn: () => load({ data: { organizationSlug, attempt } }),
    staleTime: Infinity,
  });
  const [namespaceId, setNamespaceId] = useState("");
  const [missing, setMissing] = useState(false);
  const select = useMutation({
    mutationFn: useServerFn(selectGitlabNamespace) as (
      input: Parameters<typeof selectGitlabNamespace>[0],
    ) => Promise<Result<{ result: string }>>,
    onSuccess: (response) => {
      if (response.status === "ok") onSettled("gitlab_connected");
    },
  });
  const cancel = useMutation({
    mutationFn: useServerFn(cancelGitlabConnection) as (
      input: Parameters<typeof cancelGitlabConnection>[0],
    ) => Promise<Result<{ result: string }>>,
    onSuccess: (response) => {
      if (response.status === "ok") onSettled("gitlab_cancelled");
    },
  });
  const busy = select.isPending || cancel.isPending;
  const connect = useCallback(() => {
    const chosen = Number(namespaceId);
    if (!Number.isSafeInteger(chosen) || chosen <= 0) {
      setMissing(true);
      return;
    }
    setMissing(false);
    select.mutate({ data: { organizationSlug, attempt, namespaceId: chosen } });
  }, [attempt, namespaceId, organizationSlug, select]);
  const giveUp = useCallback(
    () => cancel.mutate({ data: { organizationSlug, attempt } }),
    [attempt, cancel, organizationSlug],
  );
  const failed = candidates.data?.status === "error" || candidates.isError;
  const loaded = candidates.data?.status === "ok" ? candidates.data.data.candidates : undefined;
  const options = useMemo(
    () =>
      (loaded ?? []).map((candidate) => ({
        value: String(candidate.id),
        label: candidate.fullPath,
        detail:
          candidate.kind === "user" ? `${candidate.name} · personal namespace` : candidate.name,
        keywords: [candidate.name],
      })),
    [loaded],
  );
  const choose = useCallback((option: { value: string }) => {
    setNamespaceId(option.value);
    setMissing(false);
  }, []);
  const chosen = options.find((option) => option.value === namespaceId);
  let connectLabel = "Connect GitLab";
  if (select.isPending) connectLabel = "Connecting…";
  else if (chosen !== undefined) connectLabel = `Connect ${chosen.label}`;
  return (
    <div className="grid gap-4">
      {failed ? (
        <FailureAlert
          title="GitLab groups couldn't be read"
          error={candidates.data}
          fallback="Hub did not answer. Cancel, then start the connection again."
        />
      ) : null}
      {select.data?.status === "error" ? (
        <FailureAlert
          title="GitLab wasn't connected"
          error={select.data}
          fallback="Hub couldn't connect that group. Try again, or cancel and start over."
          focusOnArrival
        />
      ) : null}
      <FormField
        id="gitlab-namespace"
        label="Group or namespace"
        description="Groups where you are at least a Maintainer, and your own namespace. One connection covers one of them; connect again for another."
        required
        {...(missing ? { error: "Choose a group or namespace." } : {})}
      >
        {(control) => (
          <Combobox
            {...control}
            value={namespaceId}
            options={options}
            onChange={choose}
            placeholder="Select a group"
            searchPlaceholder="Search groups…"
            loading={candidates.isPending}
            disabled={busy || failed}
            empty="No groups found."
          />
        )}
      </FormField>
      <FormActions>
        <Button type="button" variant="outline" disabled={busy} onClick={giveUp}>
          Cancel
        </Button>
        <Button type="button" disabled={busy || failed} onClick={connect}>
          {connectLabel}
        </Button>
      </FormActions>
    </div>
  );
}
