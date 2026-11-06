import { isListedThreadLineage } from "@t3tools/contracts";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

export function planProjectRemoval<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "lineage">,
>(
  options: {
    readonly members: ReadonlyArray<
      Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
        readonly environmentLabel?: string | null;
      }
    >;
    readonly groupMemberCount: number;
    readonly hasOtherMembers: boolean;
    readonly displayName: string;
    readonly threads: ReadonlyArray<Thread>;
    /** The members' threads this client does not hold: older settled threads its shell left out. */
    readonly unloadedThreadCount?: number;
  },
  t: UiTranslator = translateUi.bind(null, "en"),
) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
  const projectThreads = threads.filter((thread) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  // Side chats and subagents go with their parent but never show in thread lists.
  const threadCount =
    projectThreads.filter((thread) => isListedThreadLineage(thread.lineage)).length +
    (options.unloadedThreadCount ?? 0);
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  const confirmationMessage = [
    threadCount > 0
      ? t(
          threadCount === 1
            ? 'Remove {kind} "{name}" and delete its {count} thread?'
            : 'Remove {kind} "{name}" and delete its {count} threads?',
          { kind: t(targetKind), name: targetLabel, count: threadCount },
        )
      : t('Remove {kind} "{name}"?', { kind: t(targetKind), name: targetLabel }),
    ...(singleMember
      ? [
          t("Path: {path}", { path: singleMember.workspaceRoot }),
          ...(singleMember.environmentLabel
            ? [t("Environment: {environment}", { environment: singleMember.environmentLabel })]
            : []),
        ]
      : [t("This removes {count} grouped project entries.", { count: members.length })]),
    ...(threadCount > 0
      ? [
          t(
            "Those threads and any archived threads are deleted from T3 Code. Provider sessions are kept.",
          ),
        ]
      : [t("Any archived threads are deleted from T3 Code. Provider sessions are kept.")]),
    isWholeGroup && !hasOtherMembers
      ? t("This removes only the project entries, not the files on disk.")
      : t("Other entries in this grouped project are unaffected."),
    t("This action cannot be undone."),
  ].join("\n");

  return { projectThreads, isWholeGroup, targetKind, confirmationMessage };
}
