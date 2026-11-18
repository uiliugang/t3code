import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";
import * as Meituan from "@t3tools/source-control-meituan/shared/definition";

export { readMis as readMeituanCodeMis } from "@t3tools/source-control-meituan/shared/definition";

export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [GitHub.definition, GitLab.definition, Meituan.definition],
  {
    claimChangeRequestUrlsFirst: [Meituan.definition.kind],
    recognizeRemotesIn: [Meituan.definition.kind, GitHub.definition.kind, GitLab.definition.kind],
  },
);
