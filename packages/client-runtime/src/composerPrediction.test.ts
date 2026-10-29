import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { composerPredictionKey, createComposerPredictionController } from "./composerPrediction.ts";

const target = {
  environmentId: EnvironmentId.make("one"),
  threadId: ThreadId.make("thread"),
  sourceRunId: RunId.make("run"),
};

describe("composer predictions", () => {
  it("hides late results while disabled and reuses them when enabled again", async () => {
    const pending = Promise.withResolvers<string | null>();
    const request = vi.fn(() => pending.promise);
    const controller = createComposerPredictionController(request);
    controller.update(null);
    expect(request).not.toHaveBeenCalled();
    controller.update(target);
    controller.update({ ...target });
    expect(request).toHaveBeenCalledTimes(1);
    controller.update(null);
    pending.resolve("Run the focused checks");
    await pending.promise;
    expect(controller.getSnapshot().text).toBeNull();
    controller.update(target);
    expect(request).toHaveBeenCalledTimes(1);
    await pending.promise;
    expect(controller.getSnapshot().text).toBe("Run the focused checks");
  });

  it("keeps environments and source runs separate and ignores a late result", async () => {
    const old = Promise.withResolvers<string | null>();
    const next = Promise.withResolvers<string | null>();
    const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const controller = createComposerPredictionController(request);
    const other = {
      ...target,
      environmentId: EnvironmentId.make("two"),
      sourceRunId: RunId.make("new"),
    };
    controller.update(target);
    controller.update(other);
    next.resolve("解释一下测试结果");
    await next.promise;
    old.resolve("stale");
    await old.promise;
    expect(controller.getSnapshot()).toEqual({
      key: composerPredictionKey(other),
      text: "解释一下测试结果",
    });
    controller.dismiss(composerPredictionKey(other));
    expect(controller.getSnapshot().text).toBeNull();
    controller.update(other);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers only for visible changes", async () => {
    const pending = Promise.withResolvers<string | null>();
    const controller = createComposerPredictionController(() => pending.promise);
    const changed = vi.fn();
    const dispose = controller.subscribe(changed);
    controller.update(target);
    pending.resolve("Show the diff");
    await pending.promise;
    expect(changed).toHaveBeenCalledTimes(1);
    dispose();
    controller.dismiss(composerPredictionKey(target));
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
