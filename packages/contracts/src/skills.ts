import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

const SkillKey = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/));
export const SkillUpdatePolicy = Schema.Literals(["manual", "notify", "automatic", "pinned"]);
export type SkillUpdatePolicy = typeof SkillUpdatePolicy.Type;
export const SkillSource = Schema.Struct({
  id: SkillKey,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  kind: Schema.Literals(["local", "skills", "mtskills"]),
  enabled: Schema.Boolean,
  executable: Schema.String,
  registry: Schema.String,
});
export type SkillSource = typeof SkillSource.Type;
export const SkillTarget = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  directory: Schema.String,
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
export type SkillTarget = typeof SkillTarget.Type;
const SkillVersion = Schema.Struct({ digest: SkillKey, createdAt: Schema.String });
export const SkillBinding = Schema.Struct({
  ...SkillTarget.fields,
  status: Schema.Literals(["linked", "conflict", "missing"]),
});
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
  status: Schema.Literals(["ready", "fetching", "pending", "failed", "removing"]),
  failure: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
});
export type ManagedSkill = typeof ManagedSkill.Type;
export const SkillCatalog = Schema.Struct({
  lastFailure: Schema.NullOr(Schema.String),
  sources: Schema.Array(SkillSource),
  skills: Schema.Array(ManagedSkill),
  customTargets: Schema.Array(SkillTarget),
});
export type SkillCatalog = typeof SkillCatalog.Type;
export const SkillSnapshot = Schema.Struct({
  ...SkillCatalog.fields,
  operation: Schema.NullOr(Schema.String),
  targets: Schema.Array(SkillTarget),
  discovered: Schema.Array(
    Schema.Struct({ name: Schema.String, path: Schema.String, provider: Schema.String }),
  ),
});
export type SkillSnapshot = typeof SkillSnapshot.Type;
export const SkillMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("install"),
    sourceId: SkillKey,
    locator: Schema.String.check(Schema.isMinLength(1)),
    skill: Schema.String,
    targetIds: Schema.Array(Schema.String),
    policy: SkillUpdatePolicy,
  }),
  Schema.Struct({ type: Schema.Literal("check"), id: SkillKey }),
  Schema.Struct({ type: Schema.Literal("update"), id: SkillKey }),
  Schema.Struct({ type: Schema.Literal("rollback"), id: SkillKey, digest: SkillKey }),
  Schema.Struct({ type: Schema.Literal("remove"), id: SkillKey }),
  Schema.Struct({
    type: Schema.Literal("configure"),
    id: SkillKey,
    policy: SkillUpdatePolicy,
    targetIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("source.save"), source: SkillSource }),
  Schema.Struct({ type: Schema.Literal("source.prepare"), sourceId: SkillKey }),
  Schema.Struct({ type: Schema.Literal("source.remove"), sourceId: SkillKey }),
  Schema.Struct({ type: Schema.Literal("target.save"), target: SkillTarget }),
  Schema.Struct({ type: Schema.Literal("target.remove"), targetId: Schema.String }),
]);
export type SkillMutation = typeof SkillMutation.Type;
export class SkillManagerError extends Schema.TaggedError<SkillManagerError>()(
  "SkillManagerError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "io",
      "invalid-package",
      "source-disabled",
      "not-found",
      "conflict",
      "installer-failed",
      "busy",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const messages = {
      io: "Skill storage could not be accessed.",
      "invalid-package":
        "Select one valid skill with a SKILL.md name and description. Links must stay inside the skill package.",
      "source-disabled": "Enable this skill source before installing or checking updates.",
      "not-found": "The skill, source, target or version is no longer available.",
      conflict:
        "An existing file or directory conflicts with this skill. It has not been replaced.",
      "installer-failed":
        "The skill installer failed. Check its executable, authentication and network access on this environment.",
      busy: "This skill operation is already running.",
    };
    return messages[this.reason];
  }
}
