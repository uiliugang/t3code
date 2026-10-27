import { expect, it } from "@effect/vitest";

import {
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
  sourceControlDefinitions,
} from "./sourceControlDefinitions.ts";

it("runs a driver for every host the server and clients read, in their order", () => {
  expect(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.map((driver) => driver.definition)).toEqual(
    sourceControlDefinitions.definitions,
  );
});

it("only registers GitHub and Meituan Code", () => {
  expect(sourceControlDefinitions.definitions.map((definition) => definition.kind)).toEqual([
    "github",
    "meituan",
  ]);
  expect(
    sourceControlDefinitions.recognizeRemote("git@git.sankuai.com:project/repo.git")?.kind,
  ).toBe("meituan");
  expect(
    sourceControlDefinitions.parseChangeRequestUrl(
      "https://dev.sankuai.com/code/repo-detail/project/repo/pr/42/overview",
    )?.definition.kind,
  ).toBe("meituan");
});
