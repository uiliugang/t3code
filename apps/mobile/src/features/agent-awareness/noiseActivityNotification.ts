import type {
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";

import { msg } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";

const status = {
  starting: msg("Connecting", { $context: "agent status" }),
  running: msg("Working", { $context: "agent status" }),
  stale: msg("Waiting", { $context: "agent status" }),
  waiting_for_approval: msg("Approval", { $context: "agent waits for an approval" }),
  waiting_for_input: msg("Input", { $context: "agent waits for user input" }),
  completed: msg("Done", { $context: "agent work status" }),
  failed: msg("Failed", { $context: "agent work status" }),
} satisfies Record<RelayAgentActivityState["phase"], string>;

function textField(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function noiseActivityNotification(
  environmentId: string,
  states: readonly RelayAgentActivityState[],
  preferences: RelayAgentAwarenessPreferences,
  now: number,
  resolve: MessageResolver = m,
) {
  const rows = states.flatMap((state) => {
    if (state.environmentId !== environmentId) return [];
    const updated = Date.parse(state.updatedAt);
    const terminal = state.phase === "completed" || state.phase === "failed";
    const working = state.phase === "starting" || state.phase === "running";
    const attention = state.phase === "waiting_for_approval" || state.phase === "waiting_for_input";
    const expiry = updated + (terminal ? 15 * 60_000 : (working ? 2 : 24) * 3_600_000);
    if (!Number.isFinite(expiry) || expiry <= now) return [];
    const path = `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(state.threadId)}`;
    return [
      {
        phase: state.phase,
        status: resolve(status[state.phase]),
        title: textField(state.threadTitle),
        project: textField(state.projectTitle),
        path,
        terminal,
        attention,
        updated,
        expiry,
      },
    ];
  });
  const liveRows = preferences.liveActivitiesEnabled ? rows : [];
  const card: Record<string, string> = {
    active: String(liveRows.some((row) => !row.terminal)),
    activity_active_count: String(liveRows.filter((row) => !row.terminal).length),
    activity_attention_count: String(liveRows.filter((row) => row.attention).length),
    activity_phase: liveRows[0]?.phase ?? "",
    activity_path: liveRows[0]?.path ?? "/",
    activity_expires_at: String(Math.max(0, ...liveRows.map((row) => row.expiry))),
  };
  liveRows.slice(0, 5).forEach((row, index) => {
    card[`activity_phase_${index}`] = row.phase;
    card[`activity_line_${index}`] = [row.status, row.title, row.project].join("\t");
  });
  const alerts = rows
    .filter((row) => {
      if (!preferences.notificationsEnabled || Math.abs(now - row.updated) > 10 * 60_000)
        return false;
      switch (row.phase) {
        case "waiting_for_approval":
          return preferences.notifyOnApproval;
        case "waiting_for_input":
          return preferences.notifyOnInput;
        case "completed":
          return preferences.notifyOnCompletion;
        case "failed":
          return preferences.notifyOnFailure;
        default:
          return false;
      }
    })
    .map((row) => ({
      alert_id: JSON.stringify([row.path, row.phase, row.updated]),
      alert_group: row.path,
      alert_path: row.path,
      alert_title: row.title,
      alert_body: `${row.status}: ${row.project}`,
    }));
  return { card, alerts };
}
