import type { IssueDetail, IssueEvent } from "@t3tools/contracts";

type Translate = (message: string, values?: Readonly<Record<string, string | number>>) => string;

const identityTranslate: Translate = (message, values) =>
  values
    ? message.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
        Object.hasOwn(values, key) ? String(values[key]) : placeholder,
      )
    : message;

/** "completed" → "Completed"; a reason the tracker spells with a dash reads as words. */
function issueCloseReasonLabel(reason: string): string {
  const words = reason.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function issueEventSentence(event: IssueEvent, t: Translate = identityTranslate): string {
  switch (event.kind) {
    case "closed":
      return event.detail
        ? t("closed this as {reason}", {
            reason: t(issueCloseReasonLabel(event.detail)),
          })
        : t("closed this");
    case "reopened":
      return t("reopened this");
    case "labeled":
      return event.detail
        ? t("added the {label} label", { label: event.detail })
        : t("added a label");
    case "unlabeled":
      return event.detail
        ? t("removed the {label} label", { label: event.detail })
        : t("removed a label");
    case "assigned":
      return event.detail ? t("assigned {name}", { name: event.detail }) : t("assigned someone");
    case "unassigned":
      return event.detail
        ? t("unassigned {name}", { name: event.detail })
        : t("unassigned someone");
    case "renamed":
      return event.detail
        ? t("renamed this to “{title}”", { title: event.detail })
        : t("renamed this");
    case "referenced":
      return event.detail
        ? t("referenced this from {source}", { source: event.detail })
        : t("referenced this");
    case "state-changed":
      return event.detail
        ? t("moved this to {state}", { state: event.detail })
        : t("changed the state");
  }
}

/**
 * What the viewer may do to an issue here: the client's write scope, the issue being inside a
 * project's scope, what the tracker can do at all, and what it grants this account.
 */
export function issueWriteAccess(detail: IssueDetail, canWrite: boolean) {
  const blocked = !canWrite
    ? "Writing to this tracker needs the source-control write scope."
    : !detail.writable
      ? "This issue is outside every project's own scope, so it is read-only here."
      : null;
  const may = (capability: boolean, permission: boolean) =>
    blocked === null && capability && permission;
  return {
    blocked,
    comment: may(detail.capabilities.comment, detail.viewerPermissions.comment),
    edit: may(detail.capabilities.edit, detail.viewerPermissions.edit),
    labels: may(detail.capabilities.labels, detail.viewerPermissions.labels),
    assignees: may(detail.capabilities.assignees, detail.viewerPermissions.assignees),
    react: blocked === null && detail.capabilities.reactions,
    /** The states the issue can move to; empty when the viewer may not move it. */
    states: may(true, detail.viewerPermissions.setState)
      ? detail.states.filter((state) => state.name !== detail.state.name)
      : [],
  };
}
