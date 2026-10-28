import * as Schema from "effect/Schema";
import type { ThreadWorkspaceRevision } from "@t3tools/contracts";

export function workspaceWritePaths(workspace: ThreadWorkspaceRevision): ReadonlyArray<string> {
  return [
    ...new Set(
      workspace.bindings
        .filter((binding) => binding.accessIntent === "write")
        .map((binding) => binding.executionPath),
    ),
  ];
}

const encodeWorkspaceContext = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        alias: Schema.String,
        directory: Schema.String,
        context: Schema.String,
        primary: Schema.Boolean,
      }),
    ),
  ),
);

export function workspaceContext(workspace: ThreadWorkspaceRevision): string {
  return encodeWorkspaceContext(
    workspace.bindings.map((binding) => ({
      alias: binding.alias,
      directory: binding.executionPath,
      context: binding.description,
      primary: binding.rootId === workspace.primaryRootId,
    })),
  );
}
