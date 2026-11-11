import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Board from "./MepIssueBoard.ts";

const source = { provider: "meituan" as const, scope: "1031008", host: "mep.sankuai.com" };
const row = {
  projectId: { value: "1031008", displayValue: "Test space" },
  id: { value: "1", displayValue: "1" },
  name: { value: "Title", displayValue: "Title" },
  type: { value: "REQUIREMENT", displayValue: "需求" },
  state: { value: "开发中", displayValue: "开发中", extra: { category: "DOING" } },
};
const requiredOutput =
  "本次创建的必填字段清单：\n────────\n  • 标题：未填\n  • 优先级：未填\n  • 技术主R：未填\n────────\n";

describe("MEP issue board", () => {
  it("extracts structured payloads after CLI output and only accepts numbered subtype rows", () => {
    expect(Board.mepIssueJson('Progress\n[\n{"id":1}\n]\n')).toBe('[\n{"id":1}\n]');
    expect(Board.mepIssueJson("No payload")).toBe("");
    expect(
      Board.mepSubtypeOptions(
        "结果数量: 2\n    1. 技术需求        (value: 267596)\n    2. 产品需求   (value: 267605)\ninvalid (value: 1)",
      ),
    ).toEqual([
      { value: "267596", label: "技术需求" },
      { value: "267605", label: "产品需求" },
    ]);
    expect(Board.mepRequiredFields(requiredOutput)).toEqual(["标题", "优先级", "技术主R"]);
    expect(Board.mepRequiredFields("Permission denied")).toEqual([]);
  });
  it.effect("uses a title-free CLI validation attempt for subtype-specific required fields", () =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const board = yield* Board.make.pipe(
        Effect.provide(
          TestHost.layer({
            process: {
              run: (input) => {
                calls.push(input.args);
                if (input.args[0] === "workitem-create") {
                  expect(input.args.slice(-3)).toEqual(["--title", "", "--yes"]);
                  return Effect.succeed({
                    ...TestHost.processOutput(requiredOutput),
                    exitCode: ChildProcessSpawner.ExitCode(1),
                    stderr: "错误：字段配置中未包含标题字段，且未通过 --title 传入标题",
                  });
                }
                return Effect.succeed(
                  TestHost.processOutput(
                    input.args[0] === "filter-options"
                      ? "    1. 技术需求 (value: 267596)"
                      : input.args[0] === "field-opt"
                        ? '[{"value":"me","displayValue":"Me"}]'
                        : JSON.stringify({
                            fields: [
                              {
                                id: 1,
                                name: "优先级",
                                variable: "priority",
                                type: "component_priority",
                                required: false,
                                multiple: false,
                                canEdit: true,
                                scopes: ["REQUIREMENT"],
                                possibleValues: [{ value: 2, displayValue: "中" }],
                              },
                              {
                                id: 2,
                                name: "技术主R",
                                variable: "customField25045",
                                type: "component_container_user",
                                required: true,
                                multiple: true,
                                canEdit: true,
                                scopes: ["REQUIREMENT"],
                                possibleValues: null,
                              },
                              {
                                id: 3,
                                name: "Unrelated",
                                variable: "customField1",
                                type: "text",
                                required: true,
                                multiple: false,
                                canEdit: true,
                                scopes: ["REQUIREMENT"],
                                possibleValues: null,
                              },
                            ],
                          }),
                  ),
                );
              },
            },
          }),
        ),
      );
      const input = {
        cwd: "/repo",
        source,
        projectId: ProjectId.make("p"),
        provider: "meituan" as const,
        type: "REQUIREMENT" as const,
        subtype: "",
      };
      expect((yield* board.metadata(input)).fields).toEqual([]);
      expect(calls.some((args) => args[0] === "workitem-create")).toBe(false);
      const metadata = yield* board.metadata({ ...input, subtype: "267596" });
      expect(metadata.fields.map((field) => field.variable)).toEqual([
        "priority",
        "customField25045",
      ]);
      expect(metadata.fields.every((field) => field.required)).toBe(true);
      expect(calls.find((args) => args[0] === "field-opt")).toContain("--field-id");
    }),
  );
  it.effect(
    "queries team members without an implicit current-user filter and keeps unknown states",
    () =>
      Effect.gen(function* () {
        const calls: ReadonlyArray<string>[] = [];
        const board = yield* Board.make.pipe(
          Effect.provide(
            TestHost.layer({
              process: {
                run: (input) => {
                  calls.push(input.args);
                  if (input.args.at(-1)?.includes('"IS_NULL"'))
                    return Effect.succeed(
                      TestHost.processOutput("已加载 1 个筛选条件（--cond）\n未找到匹配的工作项\n"),
                    );
                  return Effect.succeed(
                    TestHost.processOutput(
                      JSON.stringify([
                        ...(input.args.includes("full-page")
                          ? Array.from({ length: 18 }, () => row)
                          : []),
                        row,
                        {
                          ...row,
                          id: { value: "2", displayValue: "2" },
                          state: { ...row.state, extra: { category: "FUTURE" } },
                        },
                      ]),
                    ),
                  );
                },
              },
            }),
          ),
        );
        const result = yield* board.search({
          cwd: "/repo",
          source,
          assignee: "teammate",
          query: "",
          page: 2,
        });
        expect(calls[0]).toContain("space-filter");
        expect(calls[0]?.slice(calls[0].indexOf("--page"), calls[0].indexOf("--json"))).toEqual([
          "--page",
          "2",
          "--page-size",
          "20",
        ]);
        expect(calls[0]).not.toContain("workitem-workbench");
        expect(calls[0]?.at(-1)).toContain('"valueList":["teammate"]');
        expect(result.issues.map((issue) => issue.stateCategory)).toEqual(["doing", "other"]);
        expect(result.hasMore).toBe(false);
        yield* board.search({ cwd: "/repo", source, assignee: "all", query: "", page: 1 });
        expect(calls[1]).not.toContain("--cond");
        expect(
          yield* board.search({ cwd: "/repo", source, assignee: "unassigned", query: "", page: 1 }),
        ).toEqual({ issues: [], hasMore: false });
        expect(
          (yield* board.search({
            cwd: "/repo",
            source,
            assignee: "all",
            query: "full-page",
            page: 1,
          })).hasMore,
        ).toBe(true);
      }),
  );
  it.effect("verifies state changes using the state value rather than its display label", () =>
    Effect.gen(function* () {
      let state = "TODO";
      const board = yield* Board.make.pipe(
        Effect.provide(
          TestHost.layer({
            process: {
              run: (input) => {
                if (input.args[0] === "workitem-update") state = "DOING";
                return Effect.succeed(
                  TestHost.processOutput(
                    input.args[0] === "workitem-detail"
                      ? JSON.stringify({ ...row, state: { value: state, displayValue: "开发中" } })
                      : input.args[0] === "field-opt"
                        ? '[{"value":"DOING","displayValue":"开发中"}]'
                        : "Success",
                  ),
                );
              },
            },
          }),
        ),
      );
      yield* board.setState({ cwd: "/repo", source, id: "1", state: "DOING" });
      expect(state).toBe("DOING");
    }),
  );
  it.effect(
    "refuses stale transitions before invoking a write and never retries ambiguous creation",
    () =>
      Effect.gen(function* () {
        const calls: ReadonlyArray<string>[] = [];
        let rejectCreation = false;
        const board = yield* Board.make.pipe(
          Effect.provide(
            TestHost.layer({
              process: {
                run: (input) => {
                  calls.push(input.args);
                  if (rejectCreation && input.args[0] === "workitem-create")
                    return Effect.succeed({
                      ...TestHost.processOutput(""),
                      exitCode: ChildProcessSpawner.ExitCode(1),
                      stderr:
                        "❌ 发现 1 个字段问题，无法创建工作项：\n • 【缺失必填】「技术主R」未提供值",
                    });
                  return Effect.succeed(
                    TestHost.processOutput(
                      input.args[0] === "workitem-detail"
                        ? JSON.stringify(row)
                        : input.args[0] === "field-opt"
                          ? "[]"
                          : "Success without id",
                    ),
                  );
                },
              },
            }),
          ),
        );
        expect(
          (yield* board.search({
            cwd: "/repo",
            source,
            assignee: "all",
            query: "#1",
            page: 1,
          })).issues.map((issue) => issue.id),
        ).toEqual(["1"]);
        expect(
          (yield* board
            .read({ cwd: "/repo", source: { ...source, scope: "other" }, id: "1" })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-target");
        expect(
          (yield* board
            .setState({ cwd: "/repo", source, id: "1", state: "invalid" })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-state");
        expect(calls.some((args) => args[0] === "workitem-update")).toBe(false);
        const result = yield* board
          .create({
            cwd: "/repo",
            source,
            projectId: ProjectId.make("p"),
            provider: "meituan",
            type: "REQUIREMENT",
            subtype: "267596",
            title: "Title",
            body: "",
            assignees: [],
            fields: {},
          })
          .pipe(Effect.flip);
        expect(result.reason).toBe("outcome-unknown");
        expect(calls.filter((args) => args[0] === "workitem-create")).toHaveLength(1);
        rejectCreation = true;
        const rejected = yield* board
          .create({
            cwd: "/repo",
            source,
            projectId: ProjectId.make("p"),
            provider: "meituan",
            type: "REQUIREMENT",
            subtype: "267596",
            title: "Title",
            body: "",
            assignees: [],
            fields: {},
          })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          reason: "validation",
          fields: [{ variable: "技术主R", message: "技术主R未提供值" }],
        });
        expect(calls.filter((args) => args[0] === "workitem-create")).toHaveLength(2);
      }),
  );
});
