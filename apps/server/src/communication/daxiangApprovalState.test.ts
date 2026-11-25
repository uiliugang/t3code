import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  approvalMessageKey,
  approvalWatchSettingsKey,
  autoApprovalDedupeKey,
  boundedAdd,
  isProductionMcmTarget,
  isSelfAuthoredApprovalEvent,
  manualApprovalOutcome,
  shouldHandleMessageOutcome,
  shouldRememberApprovalOutcome,
  shouldReplyToSender,
} from "./daxiangApprovalState.ts";
import { parseApprovalLink } from "./daxiangApprovalLinks.ts";

it.effect("bounds insertion-order approval caches without deleting recent keys", () =>
  Effect.sync(() => {
    const keys = new Set<string>();
    for (const key of ["one", "two", "three"]) boundedAdd(keys, key, 2);
    assert.deepStrictEqual([...keys], ["two", "three"]);
    boundedAdd(keys, "two", 2);
    assert.deepStrictEqual([...keys], ["three", "two"]);
  }),
);

it.effect(
  "remembers only successful terminal outcomes, not transient skips or local-only records",
  () =>
    Effect.sync(() => {
      assert.isTrue(shouldRememberApprovalOutcome("approved", null));
      assert.isTrue(shouldRememberApprovalOutcome("notified", null));
      assert.isTrue(shouldRememberApprovalOutcome("opened", null));
      assert.isTrue(shouldRememberApprovalOutcome("skipped", "Already approved at this commit."));
      assert.isFalse(
        shouldRememberApprovalOutcome("skipped", "The MCM plan is not awaiting approval."),
      );
      assert.isFalse(shouldRememberApprovalOutcome("localOnly", null));
      assert.isFalse(shouldRememberApprovalOutcome("failed", null));
      assert.isTrue(shouldRememberApprovalOutcome("deliveryUnknown", null));
    }),
);

it.effect("does not confuse distinct messages when both message ids are absent", () =>
  Effect.sync(() => {
    const target = parseApprovalLink(
      "https://dev.sankuai.com/code/repo-detail/group/repo/pr/123/diff",
    );
    assert.isNotNull(target);
    const targets = target ? [target] : [];
    const first = approvalMessageKey({ sessionId: "chat-1" }, targets, 1);
    const second = approvalMessageKey({ sessionId: "chat-1" }, targets, 2);
    assert.notStrictEqual(first, second);
    assert.strictEqual(
      approvalMessageKey({ sessionId: "chat-1", cts: 12345 }, targets, 3),
      "chat-1:12345:pr:group/repo#123",
    );
    assert.strictEqual(
      approvalMessageKey({ sessionId: "chat-1", msgId: "message-1" }, targets, 4),
      "message-1",
    );
  }),
);

it.effect("rejects test MCM links for automatic approval while retaining production links", () =>
  Effect.sync(() => {
    const testPlan = parseApprovalLink("https://mcm.mws-test.sankuai.com/#/mine/plan/detail/456");
    const prodPlan = parseApprovalLink("https://mcm.mws.sankuai.com/#/mine/plan/detail/456");
    assert.isNotNull(testPlan);
    assert.isNotNull(prodPlan);
    assert.isFalse(isProductionMcmTarget(testPlan!));
    assert.isTrue(isProductionMcmTarget(prodPlan!));
  }),
);

it.effect("records local-only activity instead of claiming a DaXiang reminder was delivered", () =>
  Effect.sync(() => {
    assert.strictEqual(
      manualApprovalOutcome({
        browserOpened: false,
        openError: null,
        shouldNotify: true,
        daXiangDelivery: "not_configured",
      }),
      "localOnly",
    );
    assert.strictEqual(
      manualApprovalOutcome({
        browserOpened: false,
        openError: null,
        shouldNotify: true,
        daXiangDelivery: "sent",
      }),
      "notified",
    );
    assert.strictEqual(
      manualApprovalOutcome({
        browserOpened: true,
        openError: null,
        shouldNotify: false,
        daXiangDelivery: "not_configured",
      }),
      "opened",
    );
  }),
);

it.effect("treats unknown delivery as non-retryable but allows failed approvals to retry", () =>
  Effect.sync(() => {
    assert.strictEqual(
      manualApprovalOutcome({
        browserOpened: false,
        openError: null,
        shouldNotify: true,
        daXiangDelivery: "unknown",
      }),
      "deliveryUnknown",
    );
    assert.isTrue(shouldHandleMessageOutcome("deliveryUnknown"));
    assert.isFalse(shouldHandleMessageOutcome("failed"));
    assert.isTrue(shouldHandleMessageOutcome("localOnly"));
  }),
);

it.effect("separates manual and automatic dedupe keys across setting changes", () =>
  Effect.sync(() => {
    const key = "mcm-plan:mcm.mws.sankuai.com:456";
    assert.strictEqual(autoApprovalDedupeKey(key), `auto:${key}`);
    assert.isTrue(isSelfAuthoredApprovalEvent({ fromUid: "user-1" }, "user-1"));
    assert.isFalse(isSelfAuthoredApprovalEvent({ fromUid: "user-2" }, "user-1"));
    assert.isFalse(isSelfAuthoredApprovalEvent({ fromUid: "user-2" }, undefined));
    assert.isTrue(shouldReplyToSender("approved"));
    assert.isTrue(shouldReplyToSender("notified"));
    assert.isTrue(shouldReplyToSender("opened"));
    assert.isTrue(shouldReplyToSender("deliveryUnknown"));
    assert.isFalse(shouldReplyToSender("skipped"));
    assert.isFalse(shouldReplyToSender("localOnly"));
    assert.isFalse(shouldReplyToSender("failed"));
    assert.strictEqual(
      manualApprovalOutcome({
        browserOpened: false,
        openError: "spawn failed",
        shouldNotify: true,
        daXiangDelivery: "sent",
      }),
      "notified",
    );
  }),
);

it.effect("restarts the listener only for settings it actually consumes", () =>
  Effect.sync(() => {
    const settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    const unrelated: ServerSettings = {
      ...settings,
      defaultAppearance: settings.defaultAppearance === "dark" ? "light" : "dark",
    };
    assert.strictEqual(approvalWatchSettingsKey(settings), approvalWatchSettingsKey(unrelated));
    const behaviorChange: ServerSettings = {
      ...settings,
      daxiang: {
        ...settings.daxiang,
        approvalMonitor: {
          ...settings.daxiang.approvalMonitor,
          pullRequestComment: "new comment",
        },
      },
    };
    assert.strictEqual(
      approvalWatchSettingsKey(settings),
      approvalWatchSettingsKey(behaviorChange),
    );
    assert.isTrue(settings.daxiang.approvalMonitor.enhanceDumboWeb);
    assert.notStrictEqual(
      approvalWatchSettingsKey(settings),
      approvalWatchSettingsKey({
        ...settings,
        daxiang: {
          ...settings.daxiang,
          approvalMonitor: { ...settings.daxiang.approvalMonitor, enhanceDumboWeb: false },
        },
      }),
    );
    assert.notStrictEqual(
      approvalWatchSettingsKey(settings),
      approvalWatchSettingsKey({
        ...settings,
        daxiang: {
          ...settings.daxiang,
          approvalMonitor: {
            ...settings.daxiang.approvalMonitor,
            enabled: !settings.daxiang.approvalMonitor.enabled,
          },
        },
      }),
    );
  }),
);
