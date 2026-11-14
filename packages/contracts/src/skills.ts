import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

const SkillKey = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/));
// `notify` checks daily for manual application; legacy `manual` disables scheduled checks.
export const SkillUpdatePolicy = Schema.Literals(["manual", "notify", "automatic", "pinned"]);
export type SkillUpdatePolicy = typeof SkillUpdatePolicy.Type;
export const SkillFailureReason = Schema.Literals([
  "io",
  "invalid-package",
  "source-disabled",
  "target-disabled",
  "not-found",
  "conflict",
  "installer-failed",
  "busy",
  "local-changes",
  "needs-source",
  "external",
  "pinned",
  "candidate-changed",
  "interrupted",
  "installer-missing",
  "authentication",
  "network",
  "select-skill",
]);
export type SkillFailureReason = typeof SkillFailureReason.Type;
export const SkillSource = Schema.Struct({
  id: SkillKey,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  kind: Schema.Literals(["local", "skills", "mtskills"]),
  enabled: Schema.Boolean,
  executable: Schema.String,
  registry: Schema.String,
  health: Schema.optionalKey(
    Schema.Struct({
      checkedAt: Schema.String,
      reason: Schema.NullOr(SkillFailureReason),
      detail: Schema.String,
    }),
  ),
});
export type SkillSource = typeof SkillSource.Type;
export const SkillTarget = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  directory: Schema.String,
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  enabled: Schema.optionalKey(Schema.Boolean),
  hasSkills: Schema.optionalKey(Schema.Boolean),
});
export type SkillTarget = typeof SkillTarget.Type;
const SkillVersion = Schema.Struct({
  digest: SkillKey,
  createdAt: Schema.String,
  label: Schema.optionalKey(Schema.String),
});
export const SkillBinding = Schema.Struct({
  ...SkillTarget.fields,
  entryName: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["linked", "conflict", "missing"]),
});
export const SkillOrigin = Schema.Struct({
  sourceId: SkillKey,
  locator: Schema.String,
  skill: Schema.String,
  evidence: Schema.String,
});
export type SkillOrigin = typeof SkillOrigin.Type;
export const DiscoveredSkill = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  provider: Schema.String,
  identity: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  targetIds: Schema.optionalKey(Schema.Array(Schema.String)),
  origin: Schema.optionalKey(SkillOrigin),
  external: Schema.optionalKey(Schema.Boolean),
});
export type DiscoveredSkill = typeof DiscoveredSkill.Type;
export const ManagedSkill = Schema.Struct({
  id: SkillKey,
  name: SkillKey,
  description: Schema.String,
  sourceId: SkillKey,
  sourceLabel: Schema.String,
  locator: Schema.String,
  requestedSkill: Schema.String,
  versions: Schema.Array(SkillVersion),
  activeDigest: Schema.NullOr(SkillKey),
  availableDigest: Schema.NullOr(SkillKey),
  bindings: Schema.Array(SkillBinding),
  policy: SkillUpdatePolicy,
  policyOrigin: Schema.optionalKey(Schema.Literals(["default", "explicit", "legacy"])),
  status: Schema.Literals(["ready", "fetching", "pending", "failed", "removing"]),
  phase: Schema.optionalKey(
    Schema.Literals(["checking", "downloading", "prepared", "waiting", "applying"]),
  ),
  failure: Schema.NullOr(Schema.String),
  failureReason: Schema.optionalKey(Schema.NullOr(SkillFailureReason)),
  failureDiagnostics: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checkedAt: Schema.NullOr(Schema.String),
  lastAttemptAt: Schema.optionalKey(Schema.String),
  snapshotOnly: Schema.optionalKey(Schema.Boolean),
  adoptedFrom: Schema.optionalKey(Schema.String),
  workKey: Schema.optionalKey(SkillKey),
  pendingUnmanage: Schema.optionalKey(Schema.Struct({ restore: Schema.Boolean, digest: SkillKey })),
  pendingActivation: Schema.optionalKey(Schema.Struct({ digest: SkillKey, workKey: SkillKey })),
  adoptionState: Schema.optionalKey(Schema.Literals(["preparing", "complete"])),
  cancelledDigest: Schema.optionalKey(Schema.NullOr(SkillKey)),
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
  backups: Schema.optionalKey(
    Schema.Array(Schema.Struct({ original: Schema.String, backup: Schema.String })),
  ),
});
export type ManagedSkill = typeof ManagedSkill.Type;
export const SkillCopySource = Schema.Union([
  Schema.Struct({ id: SkillKey }),
  Schema.Struct({ path: Schema.String }),
]);
export type SkillCopySource = typeof SkillCopySource.Type;
export const SkillCopyPackage = Schema.Struct({
  name: SkillKey,
  digest: SkillKey,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      contents: Schema.String.check(Schema.isMaxLength(36 * 1024 * 1024)),
      mode: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 0o777 })),
    }),
  ).check(Schema.isMaxLength(1000)),
});
export type SkillCopyPackage = typeof SkillCopyPackage.Type;
export const SkillCopyPreviewInput = Schema.Struct({
  directory: Schema.String,
  names: Schema.Array(SkillKey).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type SkillCopyPreviewInput = typeof SkillCopyPreviewInput.Type;
export const SkillCopyPreview = Schema.Struct({
  directory: Schema.String,
  entries: Schema.Array(
    Schema.Struct({ name: SkillKey, status: Schema.Literals(["new", "skill", "directory"]) }),
  ),
});
export type SkillCopyPreview = typeof SkillCopyPreview.Type;
export const SkillCopyInput = Schema.Struct({
  directory: Schema.String,
  package: SkillCopyPackage,
});
export type SkillCopyInput = typeof SkillCopyInput.Type;
export const SkillAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("copy"),
    name: SkillKey,
    directory: Schema.String,
    digest: SkillKey,
    workKey: SkillKey,
  }),
  Schema.Struct({ type: Schema.Literal("refresh") }),
  Schema.Struct({
    type: Schema.Literal("install"),
    sourceId: SkillKey,
    locator: Schema.String.check(Schema.isMinLength(1)),
    skill: Schema.String,
    targetIds: Schema.Array(Schema.String),
    policy: Schema.optionalKey(SkillUpdatePolicy),
  }),
  Schema.Struct({
    type: Schema.Literal("adopt"),
    path: Schema.String,
    digest: SkillKey,
    mode: Schema.Literals(["copy", "takeover"]),
    targetIds: Schema.Array(Schema.String),
    origin: Schema.optionalKey(SkillOrigin),
    policy: Schema.optionalKey(SkillUpdatePolicy),
  }),
  Schema.Struct({ type: Schema.Literal("check"), id: SkillKey }),
  Schema.Struct({
    type: Schema.Literal("update"),
    id: SkillKey,
    digest: Schema.optionalKey(SkillKey),
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), id: SkillKey }),
  Schema.Struct({ type: Schema.Literal("rollback"), id: SkillKey, digest: SkillKey }),
  Schema.Struct({ type: Schema.Literal("remove"), id: SkillKey }),
  Schema.Struct({ type: Schema.Literal("unmanage"), id: SkillKey, restore: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("resolve"),
    id: SkillKey,
    resolution: Schema.Literals(["keep", "upstream"]),
    digest: SkillKey,
  }),
  Schema.Struct({ type: Schema.Literal("select"), id: SkillKey, skill: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("origin"),
    id: SkillKey,
    sourceId: SkillKey,
    locator: Schema.String,
    skill: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("policy"), id: SkillKey, policy: SkillUpdatePolicy }),
  Schema.Struct({
    type: Schema.Literal("configure"),
    id: SkillKey,
    policy: SkillUpdatePolicy,
    targetIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("source.save"), source: SkillSource }),
  Schema.Struct({ type: Schema.Literal("source.prepare"), sourceId: SkillKey }),
  Schema.Struct({ type: Schema.Literal("source.check"), sourceId: SkillKey }),
  Schema.Struct({ type: Schema.Literal("source.remove"), sourceId: SkillKey }),
  Schema.Struct({ type: Schema.Literal("target.save"), target: SkillTarget }),
  Schema.Struct({ type: Schema.Literal("target.remove"), targetId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("target.configure"),
    targetId: Schema.String,
    enabled: Schema.Boolean,
  }),
]);
export type SkillAction = typeof SkillAction.Type;
export const SkillMutation = Schema.Union([
  SkillAction,
  Schema.Struct({
    type: Schema.Literal("batch"),
    operations: Schema.Array(SkillAction).check(Schema.isMaxLength(200)),
  }),
]);
export type SkillMutation = typeof SkillMutation.Type;
export const SkillJob = Schema.Struct({
  id: Schema.String,
  input: SkillAction,
  origin: Schema.Literals(["user", "schedule", "recovery"]),
  status: Schema.Literals(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
  createdAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  skillId: Schema.optionalKey(Schema.String),
  beforeDigest: Schema.optionalKey(Schema.NullOr(SkillKey)),
  afterDigest: Schema.optionalKey(Schema.NullOr(SkillKey)),
  reason: Schema.NullOr(SkillFailureReason),
  diagnostics: Schema.optionalKey(Schema.String),
});
export type SkillJob = typeof SkillJob.Type;
export const SkillCatalog = Schema.Struct({
  lastFailure: Schema.NullOr(Schema.String),
  lastFailureReason: Schema.optionalKey(Schema.NullOr(SkillFailureReason)),
  lastFailureDiagnostics: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sources: Schema.Array(SkillSource),
  skills: Schema.Array(ManagedSkill),
  customTargets: Schema.Array(SkillTarget),
  targetSettings: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        directory: Schema.String,
        state: Schema.Literals(["disabled", "removed"]),
      }),
    ),
  ),
  jobs: Schema.optionalKey(Schema.Array(SkillJob)),
});
export type SkillCatalog = typeof SkillCatalog.Type;
export const SkillSnapshot = Schema.Struct({
  ...SkillCatalog.fields,
  operation: Schema.NullOr(Schema.String),
  targets: Schema.Array(SkillTarget),
  discovered: Schema.Array(DiscoveredSkill),
  scannedAt: Schema.optionalKey(Schema.String),
});
export type SkillSnapshot = typeof SkillSnapshot.Type;
export const SkillInspect = Schema.Union([
  Schema.Struct({ type: Schema.Literal("adopt"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("diff"), id: SkillKey }),
]);
export type SkillInspect = typeof SkillInspect.Type;
export const SkillInspection = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  digest: SkillKey,
  candidateDigest: Schema.NullOr(SkillKey),
  origin: Schema.optionalKey(SkillOrigin),
  external: Schema.Boolean,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.Literals(["added", "removed", "changed", "unchanged"]),
      before: Schema.String,
      after: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
});
export type SkillInspection = typeof SkillInspection.Type;
export class SkillManagerError extends Schema.TaggedError<SkillManagerError>()(
  "SkillManagerError",
  {
    operation: Schema.String,
    reason: SkillFailureReason,
    choices: Schema.optionalKey(Schema.Array(Schema.String)),
    diagnostics: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return skillFailureMessage(this.reason);
  }
}
export function skillFailureMessage(reason: SkillFailureReason): string {
  return {
    io: "Skill storage could not be accessed.",
    "invalid-package":
      "Select one valid skill with a SKILL.md name and description. Links must stay inside the skill package.",
    "source-disabled": "Enable this skill source before installing or checking updates.",
    "target-disabled": "Enable this usage location before linking skills.",
    "not-found": "The skill, source, target or version is no longer available.",
    conflict: "An existing file or directory conflicts with this skill. It has not been replaced.",
    "installer-failed":
      "The skill installer failed. Check its executable, authentication and network access on this environment.",
    busy: "Agents in this environment are still active. Try again when they are idle.",
    "local-changes": "Local changes were found. Review them before applying an update.",
    "needs-source": "Automatic updates are enabled. Connect an update source to continue.",
    external: "This skill is maintained by its plugin or provider. Update it there.",
    pinned: "This version is pinned. Change the update policy before updating.",
    "candidate-changed": "The reviewed content has changed. Refresh and review it again.",
    interrupted: "This operation was interrupted. Review the result before retrying.",
    "installer-missing": "The installer is unavailable. Prepare it or configure its executable.",
    authentication: "The source requires authentication. Sign in on this environment and retry.",
    network: "The source could not be reached. Check network access on this environment.",
    "select-skill": "This package contains multiple skills. Choose one to continue.",
  }[reason];
}
