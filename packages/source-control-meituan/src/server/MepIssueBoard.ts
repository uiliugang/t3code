import { IssueError, type Issue, type IssueOption, type IssueSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Host from "@t3tools/source-control-core/server/SourceControlHost";
import type * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";

const Value = Schema.Union([Schema.String, Schema.Number]);
const Field = Schema.Struct({
  value: Schema.NullOr(Value),
  displayValue: Schema.NullOr(Schema.String),
  extra: Schema.optional(
    Schema.NullOr(Schema.Struct({ category: Schema.optional(Schema.String) })),
  ),
});
const Row = Schema.Struct({
  id: Field,
  name: Field,
  state: Field,
  type: Field,
  assigned: Schema.optional(Field),
  priority: Schema.optional(Field),
  updatedAt: Schema.optional(Field),
  description: Schema.optional(Field),
  projectId: Schema.optional(Field),
});
const Options = Schema.Array(
  Schema.Struct({
    value: Value,
    displayValue: Schema.String,
    disabled: Schema.optional(Schema.Boolean),
    extra: Schema.optional(
      Schema.NullOr(Schema.Struct({ category: Schema.optional(Schema.String) })),
    ),
  }),
);
const MetadataField = Schema.Struct({
  id: Value,
  variable: Schema.String,
  name: Schema.String,
  type: Schema.String,
  required: Schema.Boolean,
  multiple: Schema.Boolean,
  canEdit: Schema.Boolean,
  scopes: Schema.Array(Schema.String),
  possibleValues: Schema.NullOr(Options),
});
const FieldMenus = Schema.Record(Schema.String, Schema.Array(MetadataField));
const decodeRows = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Row)));
const encodeAssignee = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      field: Schema.String,
      type: Schema.String,
      valueList: Schema.Array(Schema.String),
      fieldType: Schema.String,
    }),
  ),
);

export function mepIssueJson(stdout: string): string {
  const start = stdout.search(/^[[{]/mu);
  return start < 0 ? "" : stdout.slice(start).trim();
}

export function mepSubtypeOptions(stdout: string): IssueOption[] {
  // ones2 1.0.56 exposes subtype filters only as numbered text rows.
  return [...stdout.matchAll(/^\s+\d+\.\s+(.+?)\s+\(value: ([1-9]\d*)\)\s*$/gmu)].map((match) => ({
    value: match[2]!,
    label: match[1]!.trim(),
  }));
}

export function mepRequiredFields(output: string): string[] {
  const block = /本次创建的必填字段清单：[\s\S]*?\n[─-]+\n([\s\S]*?)\n[─-]+/u.exec(output)?.[1];
  return block ? [...block.matchAll(/^\s*• (.+?)：/gmu)].map((match) => match[1]!) : [];
}

function validationFields(output: string) {
  return [...output.matchAll(/【(?:缺失必填|非法值)】「([^」]+)」([^\n]*)/gu)].map((match) => ({
    variable: match[1]!,
    message: `${match[1]}${match[2]}`,
  }));
}

function fromRow(row: typeof Row.Type, scope: string): Issue {
  const type = String(row.type.value ?? "REQUIREMENT");
  const path = type === "DEVTASK" ? "devtask" : type === "DEFECT" ? "defect" : "requirement";
  const category = row.state.extra?.category;
  return {
    id: String(row.id.value),
    title: row.name.displayValue ?? "",
    state: row.state.displayValue ?? "",
    stateCategory:
      category === "TODO"
        ? "todo"
        : category === "DOING"
          ? "doing"
          : category === "DONE"
            ? "done"
            : "other",
    url: `https://mep.sankuai.com/app/ones/space/${scope}/workItem/${path}/detail/${row.id.value}`,
    type,
    assignees: row.assigned?.value
      ? [
          {
            value: String(row.assigned.value),
            label: row.assigned.displayValue ?? String(row.assigned.value),
          },
        ]
      : [],
    priority: row.priority?.displayValue ?? "",
    updatedAt: String(row.updatedAt?.value ?? ""),
  };
}

export const make = Effect.gen(function* () {
  const host = yield* Host.SourceControlHost;
  const execute = Effect.fn("MepIssueBoard.execute")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    write = false,
  ) {
    return yield* host.process
      .run({
        cwd,
        command: "ones2",
        operation: "issues",
        args,
        stdin: "",
        allowNonZeroExit: true,
        timeoutMs: 60_000,
        maxOutputBytes: 2_000_000,
        concurrency: { key: "mep-ones-cli", limit: 2 },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new IssueError({
              operation: "mep",
              reason: write ? "outcome-unknown" : "unavailable",
              cause,
            }),
        ),
      );
  });
  const run = Effect.fn("MepIssueBoard.run")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    write = false,
  ) {
    const output = yield* execute(cwd, args, write);
    if (output.exitCode !== 0) {
      const fields = validationFields(output.stderr);
      return yield* new IssueError({
        operation: "mep",
        reason: fields.length ? "validation" : write ? "outcome-unknown" : "unavailable",
        fields,
      });
    }
    return output.stdout;
  });
  const json = Effect.fn("MepIssueBoard.json")(function* <A>(
    cwd: string,
    args: ReadonlyArray<string>,
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      mepIssueJson(yield* run(cwd, args)),
    ).pipe(
      Effect.mapError(
        (cause) => new IssueError({ operation: "decode", reason: "unavailable", cause }),
      ),
    );
  });
  const options = Effect.fn("MepIssueBoard.options")(function* (
    cwd: string,
    scope: string,
    type: string,
    variable: string,
    issueType: string,
    extra: ReadonlyArray<string> = [],
  ) {
    const rows = yield* json(
      cwd,
      [
        "field-opt",
        "query",
        "--type",
        type,
        "--space",
        scope,
        "--issue-type",
        issueType,
        "--variable",
        variable,
        ...extra,
        "--json",
      ],
      Options,
    );
    return rows
      .filter((row) => !row.disabled)
      .map((row) => ({
        value: String(row.value),
        label: row.displayValue,
        ...(row.extra?.category ? { category: row.extra.category } : {}),
      }));
  });
  const readRow = Effect.fn("MepIssueBoard.readRow")(function* ({
    source,
    cwd,
    id,
  }: {
    readonly source: IssueSource;
    readonly cwd: string;
    readonly id: string;
  }) {
    const row = yield* json(
      cwd,
      ["workitem-detail", "info", "--workitem", id, "--space", source.scope, "--json"],
      Row,
    );
    if (row.projectId?.value && String(row.projectId.value) !== source.scope)
      return yield* new IssueError({ operation: "read", reason: "invalid-target" });
    return row;
  });
  const read: NonNullable<Provider.SourceControlProvider["Service"]["issueBoard"]>["read"] =
    Effect.fn("MepIssueBoard.read")(function* ({ cwd, source, id }) {
      const row = yield* readRow({ cwd, source, id });
      const transitions = yield* options(
        cwd,
        source.scope,
        "component_state",
        "state",
        String(row.type.value),
        ["--workitem-id", id],
      );
      return {
        ...fromRow(row, source.scope),
        body: row.description?.displayValue ?? "",
        bodyFormat: "html" as const,
        transitions,
      };
    });
  return {
    search: Effect.fn("MepIssueBoard.search")(function* (input) {
      let assignee = input.assignee;
      if (assignee === "me") {
        const config = yield* run(input.cwd, ["config"]);
        assignee = /MIS 账号[：:]\s+([\w.-]+)/u.exec(config)?.[1] ?? "";
        if (!assignee) return yield* new IssueError({ operation: "viewer", reason: "unavailable" });
      }
      const id = /^#?([1-9]\d*)$/u.exec(input.query)?.[1];
      if (id) {
        if (input.page !== 1) return { issues: [], hasMore: false };
        const issue = yield* read({ cwd: input.cwd, source: input.source, id });
        const matches =
          assignee === "all" ||
          (assignee === "unassigned"
            ? !issue.assignees.length
            : issue.assignees.some((person) => person.value === assignee));
        return { issues: matches ? [issue] : [], hasMore: false };
      }
      const args = [
        "space-filter",
        "--space",
        input.source.scope,
        "--type",
        "requirement,devtask,defect",
        "--page",
        String(input.page),
        "--page-size",
        "20",
        "--json",
      ];
      if (input.query) args.push("--name", input.query);
      if (assignee !== "all")
        args.push(
          "--cond",
          encodeAssignee({
            field: "assigned",
            type: assignee === "unassigned" ? "IS_NULL" : "TERMS",
            valueList: assignee === "unassigned" ? [] : [assignee],
            fieldType: "component_user",
          }),
        );
      const stdout = yield* run(input.cwd, args);
      const payload = mepIssueJson(stdout);
      if (!payload && /(?:^|\n)未找到匹配的工作项\s*$/u.test(stdout))
        return { issues: [], hasMore: false };
      const rows = yield* decodeRows(payload).pipe(
        Effect.mapError(
          (cause) => new IssueError({ operation: "search", reason: "unavailable", cause }),
        ),
      );
      return {
        issues: rows.map((row) => fromRow(row, input.source.scope)),
        hasMore: rows.length === 20,
      };
    }),
    read,
    people: Effect.fn("MepIssueBoard.people")(function* ({ cwd, source, query }) {
      return yield* options(cwd, source.scope, "component_user", "assigned", "REQUIREMENT", [
        "--keyword",
        query,
      ]);
    }),
    metadata: Effect.fn("MepIssueBoard.metadata")(function* (input) {
      const subtypes = mepSubtypeOptions(
        yield* run(input.cwd, [
          "filter-options",
          "query",
          "--type",
          "subtype",
          "--space",
          input.source.scope,
          "--workitem-types",
          input.type,
        ]),
      );
      if (!input.subtype) return { subtypes, fields: [] };
      if (!subtypes.some((option) => option.value === input.subtype))
        return yield* new IssueError({
          operation: "metadata",
          reason: "validation",
          fields: [{ variable: "subtypeId", message: "Select a work item subtype." }],
        });
      // An empty title makes ones2 --yes exit before writing, even when all other fields have defaults.
      const probe = yield* execute(input.cwd, [
        "workitem-create",
        "--type",
        input.type,
        "--project-id",
        input.source.scope,
        "--subtype",
        input.subtype,
        "--title",
        "",
        "--yes",
      ]);
      const required = mepRequiredFields(probe.stdout);
      if (probe.exitCode === 0 || !required.length || !/标题|无法创建/u.test(probe.stderr))
        return yield* new IssueError({ operation: "metadata", reason: "unavailable" });
      const menus = yield* json(
        input.cwd,
        [
          "container-fields",
          "--space",
          input.source.scope,
          "--workitem-types",
          input.type,
          "--json",
        ],
        FieldMenus,
      );
      const allFields = Object.values(menus).flat();
      const fields = yield* Effect.forEach(
        required.filter((name) => name !== "标题"),
        (name) =>
          Effect.gen(function* () {
            const field = allFields.find(
              (entry) => entry.name === name && entry.canEdit && entry.scopes.includes(input.type),
            );
            if (!field)
              return yield* new IssueError({ operation: "metadata", reason: "unavailable" });
            const choices = field.possibleValues?.length
              ? field.possibleValues
                  .filter((option) => !option.disabled)
                  .map((option) => ({ value: String(option.value), label: option.displayValue }))
              : /user|list|priority|classify|module|version|iteration|label|parent|org|cascader/u.test(
                    field.type,
                  )
                ? yield* options(
                    input.cwd,
                    input.source.scope,
                    field.type,
                    field.variable,
                    input.type,
                    [
                      "--subtype-id",
                      input.subtype,
                      "--field-id",
                      String(field.id),
                      "--keyword",
                      input.query ?? "",
                    ],
                  )
                : [];
            return {
              variable: field.variable,
              label: field.name,
              type: field.type.includes("user")
                ? ("person" as const)
                : field.type.includes("time")
                  ? ("date" as const)
                  : choices.length
                    ? ("select" as const)
                    : ("text" as const),
              required: true,
              multiple: field.multiple,
              options: choices,
            };
          }),
        { concurrency: 2 },
      );
      return { subtypes, fields };
    }),
    create: Effect.fn("MepIssueBoard.create")(function* (input) {
      if (!input.subtype)
        return yield* new IssueError({
          operation: "create",
          reason: "validation",
          fields: [{ variable: "subtypeId", message: "Select a work item subtype." }],
        });
      const args = [
        "workitem-create",
        "--type",
        input.type,
        "--project-id",
        input.source.scope,
        "--subtype",
        input.subtype,
        "--title",
        input.title,
        "--desc",
        input.body,
        "--yes",
      ];
      if (input.assignees[0]) args.push("--assigned", input.assignees[0]);
      for (const [variable, value] of Object.entries(input.fields)) {
        if (
          !/^(?:customField\d+|priority|assigned|cc|parentId|moduleId|severity|expectStart|expectClose)$/u.test(
            variable,
          )
        )
          return yield* new IssueError({ operation: "create", reason: "validation" });
        if (value) args.push("--set", `${variable}=${value}`);
      }
      const stdout = yield* run(input.cwd, args, true);
      // ones2 has no JSON create result; verify its returned id through the structured detail command.
      const id = /^\s*工作项 ID[：:]\s+([1-9]\d*)\s*$/mu.exec(stdout)?.[1];
      if (!id) return yield* new IssueError({ operation: "create", reason: "outcome-unknown" });
      return yield* read({ cwd: input.cwd, source: input.source, id }).pipe(
        Effect.mapError(
          (cause) => new IssueError({ operation: "create", reason: "outcome-unknown", cause }),
        ),
      );
    }),
    setState: Effect.fn("MepIssueBoard.setState")(function* (input) {
      const current = yield* read(input);
      if (!current.transitions.some((option) => option.value === input.state))
        return yield* new IssueError({ operation: "setState", reason: "invalid-state" });
      yield* run(
        input.cwd,
        [
          "workitem-update",
          "-i",
          input.id,
          "--space",
          input.source.scope,
          "--set",
          `state=${input.state}`,
          "--yes",
        ],
        true,
      );
      const updated = yield* readRow(input);
      if (String(updated.state.value) !== input.state)
        return yield* new IssueError({ operation: "setState", reason: "outcome-unknown" });
    }),
  } satisfies NonNullable<Provider.SourceControlProvider["Service"]["issueBoard"]>;
});
