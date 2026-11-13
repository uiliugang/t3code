import * as Option from "effect/Option";
import { defineRule } from "@oxlint/plugins";
import { getPropertyName } from "../utils.ts";

const automaticMethods = new Set(["stopThreadServers", "closeOnSettle", "closeRetired"]);

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep automatic resource retirement in its shared lifecycle boundary." },
    schema: [],
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (
      filename.endsWith("/orchestration-v2/ResourceCleanupService.ts") ||
      /\.(?:test|testkit)\.[cm]?[jt]sx?$/.test(filename)
    )
      return {};
    return {
      MemberExpression(node) {
        if (!automaticMethods.has(Option.getOrUndefined(getPropertyName(node.property)) ?? ""))
          return;
        context.report({
          node,
          message:
            "Use ResourceCleanupService.cleanupRuntime in apps/server/src/orchestration-v2/ResourceCleanupService.ts; it validates retirement and isolates resource failures.",
        });
      },
    };
  },
});
