import { expect, it } from "vite-plus/test";
import { translateUi } from "@t3tools/shared/uiLocale";

import { formatRelativeElapsed } from "./timestampFormat";

it("localizes relative time while preserving the compact English format", () => {
  const t = translateUi.bind(null, "zh-CN");
  expect(formatRelativeElapsed(0, t)).toEqual({ value: "刚刚", suffix: null });
  expect(formatRelativeElapsed(60_000, t)).toEqual({ value: "1分钟", suffix: "前" });
  expect(formatRelativeElapsed(3_600_000, t)).toEqual({ value: "1小时", suffix: "前" });
  expect(formatRelativeElapsed(105 * 86_400_000, t)).toEqual({ value: "105天", suffix: "前" });
  expect(formatRelativeElapsed(105 * 86_400_000)).toEqual({ value: "105d", suffix: "ago" });
  expect(translateUi("zh-CN", "{value} {suffix}", { value: "105天", suffix: "前" })).toBe(
    "105天前",
  );
});
