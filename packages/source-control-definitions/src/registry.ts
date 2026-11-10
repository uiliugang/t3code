/* oxlint-disable t3code/no-low-value-comments -- Keep the disabled registrations as explicitly requested. */
import * as AzureDevOps from "@t3tools/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@t3tools/source-control-bitbucket/shared/definition";
import {
  makeSourceControlDefinitionRegistry,
  type SourceControlDefinitionRegistry,
} from "@t3tools/source-control-core/shared/definition";
import * as CursorOrigin from "@t3tools/source-control-cursor-origin/shared/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/shared/definition";
import * as GitCafe from "@t3tools/source-control-gitcafe/shared/definition";
import * as GitHub from "@t3tools/source-control-github/shared/definition";
import * as GitLab from "@t3tools/source-control-gitlab/shared/definition";
import * as Meituan from "@t3tools/source-control-meituan/shared/definition";

export { readMis as readMeituanCodeMis } from "@t3tools/source-control-meituan/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first to preserve the client default for repositories with an unknown host.
 * GitCafe and Cursor Origin claim URLs first because GitHub and Forgejo accept the same routes on
 * any hostname.
 * Remote recognition needs its own order because host labels can overlap (`gitea.github.example`).
 */
export const knownSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    CursorOrigin.definition,
    GitLab.definition,
    GitCafe.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
    Meituan.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [
      GitCafe.definition.kind,
      CursorOrigin.definition.kind,
      Meituan.definition.kind,
      AzureDevOps.definition.kind,
    ],
    recognizeRemotesIn: [
      Meituan.definition.kind,
      GitCafe.definition.kind,
      CursorOrigin.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);

// Keep saved links and repository identities readable when a host's entry is disabled.
export const builtInSourceControlDefinitions: SourceControlDefinitionRegistry = {
  ...knownSourceControlDefinitions,
  definitions: [
    GitHub.definition,
    // GitLab.definition,
    // GitCafe.definition,
    // Forgejo.definition,
    // Bitbucket.definition,
    // AzureDevOps.definition,
    Meituan.definition,
  ],
};
