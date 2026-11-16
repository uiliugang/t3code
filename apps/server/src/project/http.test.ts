import { expect, it } from "@effect/vitest";
import { AuthSettingsWriteScope, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectHttp from "./http.ts";
import * as ProjectService from "./ProjectService.ts";

it.effect("rejects invalid project mutations as client errors", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project");
    for (const cause of [
      new ProjectService.ProjectInvalidError({ projectId, detail: "Invalid script id." }),
      new ProjectService.ProjectWorkspaceRootChangeBlockedError({ projectId }),
    ]) {
      const error = yield* ProjectHttp.failProjectMutation(cause).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentRequestInvalidError",
        reason: "invalid_command",
      });
    }
    const scopeError = yield* ProjectHttp.failProjectMutation(
      new ProjectService.ProjectSetupScriptAuthorizationError({ projectId }),
    ).pipe(Effect.flip);
    expect(scopeError).toMatchObject({
      _tag: "EnvironmentScopeRequiredError",
      requiredPermission: AuthSettingsWriteScope,
    });
  }),
);
