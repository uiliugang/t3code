import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { expect, it } from "vite-plus/test";
import { noiseActivityNotification } from "./noiseActivityNotification";

const environment = EnvironmentId.make("home");
const now = Date.parse("2026-01-01T12:00:00Z");
const all: RelayAgentAwarenessPreferences = {
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
function row(
  phase: RelayAgentActivityState["phase"],
  overrides?: Partial<RelayAgentActivityState>,
): RelayAgentActivityState {
  return {
    environmentId: environment,
    threadId: ThreadId.make("a/b"),
    projectTitle: "Project",
    threadTitle: "Thread",
    headline: "Action",
    modelTitle: "Model",
    phase,
    updatedAt: new Date(now).toISOString(),
    deepLink: "https://other.invalid/",
    ...overrides,
  };
}
it("only uses fresh rows for this host and builds the action from the approved thread", () => {
  const state = row("waiting_for_input");
  const rows = [
    state,
    row("completed", { updatedAt: new Date(now - 16 * 60_000).toISOString() }),
    row("running", { environmentId: EnvironmentId.make("other") }),
  ];
  const { card, alerts } = noiseActivityNotification(environment, rows, all, now);
  expect(card).toMatchObject({
    active: "true",
    activity_active_count: "1",
    activity_attention_count: "1",
    activity_path: "/threads/home/a%2Fb",
    activity_line_0: "Input\tThread\tProject",
  });
  expect(card.activity_line_1).toBeUndefined();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.alert_path).toBe("/threads/home/a%2Fb");
  expect(noiseActivityNotification(environment, [state], all, now + 500).alerts).toEqual(alerts);
  expect(noiseActivityNotification(environment, [], all, now)).toMatchObject({
    card: { active: "false", activity_expires_at: "0" },
    alerts: [],
  });
});

it("applies per-class alerts independently from live activity permission", () => {
  const rows = [
    row("waiting_for_input"),
    row("waiting_for_approval"),
    row("failed"),
    row("completed"),
  ];
  const result = noiseActivityNotification(
    environment,
    rows,
    { ...all, liveActivitiesEnabled: false, notifyOnApproval: false, notifyOnFailure: false },
    now,
  );
  expect(result.card.activity_expires_at).toBe("0");
  expect(result.alerts.map((alert) => alert.alert_body)).toEqual([
    "Input: Project",
    "Done: Project",
  ]);
  expect(
    noiseActivityNotification(environment, rows, { ...all, notificationsEnabled: false }, now),
  ).toMatchObject({ card: { active: "true" }, alerts: [] });
});
