import { useId, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  skillFailureMessage,
  type DiscoveredSkill,
  type EnvironmentId,
  type ManagedSkill,
  type SkillAction,
  type SkillInspect,
  type SkillInspection,
  type SkillMutation,
  type SkillSnapshot,
  type SkillSource,
  type SkillTarget,
  type SkillUpdatePolicy,
} from "@t3tools/contracts";
import {
  skillPolicies,
  skillJobNames,
  skillFilters,
  skillRows,
  skillStatus,
  skillFailure,
  skillNextCheck,
  skillSourceName,
  type SkillFilter,
} from "@t3tools/shared/skillsUi";
import {
  ArrowDownToLineIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FolderIcon,
  GlobeIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestConfirmDialog } from "../../confirmDialog";
import { randomUUID } from "../../lib/utils";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Checkbox } from "../ui/checkbox";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

type Mutate = (input: SkillMutation) => Promise<boolean>;
type Inspect = (input: SkillInspect) => Promise<SkillInspection | null>;
function Action({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
function SkillTime({ value }: { value: string | null | undefined }) {
  const t = useUiTranslation();
  const language = useClientSettings((settings) => settings.uiLanguage);
  return <>{value ? new Date(value).toLocaleString(language) : t("Not checked")}</>;
}
function PolicySelect({
  value,
  onChange,
  disabled,
}: {
  value: SkillUpdatePolicy;
  onChange: (policy: SkillUpdatePolicy) => void;
  disabled?: boolean;
}) {
  const t = useUiTranslation();
  return (
    <Select
      value={value === "manual" ? "pinned" : value}
      onValueChange={(next) => next && onChange(next)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={t("Update policy")}>
        <SelectValue>{t(skillPolicies[value])}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {Object.entries(skillPolicies)
          .filter(([key]) => key !== "manual")
          .map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {t(label)}
            </SelectItem>
          ))}
      </SelectPopup>
    </Select>
  );
}
function SourceSelect({
  data,
  value,
  onChange,
}: {
  data: SkillSnapshot;
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useUiTranslation();
  const source = data.sources.find((item) => item.id === value);
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger aria-label={t("Skill source")}>
        <SelectValue>{source ? skillSourceName(source, t) : t("Choose source")}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {data.sources.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {skillSourceName(item, t)}
            {!item.enabled && ` · ${t("Disabled")}`}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
function Targets({
  targets,
  selected,
  onChange,
}: {
  targets: ReadonlyArray<SkillTarget>;
  selected: ReadonlyArray<string>;
  onChange: (ids: string[]) => void;
}) {
  const t = useUiTranslation();
  const [paths, setPaths] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t("{count} locations selected", { count: selected.length })}</span>
        <Button variant="ghost" size="sm" onClick={() => setPaths(!paths)}>
          {t(paths ? "Hide paths" : "Show paths")}
        </Button>
      </div>
      <div className="divide-y divide-border">
        {targets.map((target) => (
          <label key={target.id} className="flex cursor-pointer items-start gap-3 py-2.5 text-sm">
            <Checkbox
              aria-label={target.id === "directory:shared" ? t("Shared skills") : target.label}
              checked={selected.includes(target.id)}
              onCheckedChange={(checked) =>
                onChange(
                  checked ? [...selected, target.id] : selected.filter((id) => id !== target.id),
                )
              }
            />
            <span className="min-w-0">
              <span className="block">
                {target.id === "directory:shared" ? t("Shared skills") : target.label}
              </span>
              {paths && (
                <span className="mt-1 block font-mono text-xs text-muted-foreground wrap-anywhere">
                  {target.directory}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
function InstallDialog({
  data,
  mutate,
  onClose,
}: {
  data: SkillSnapshot;
  mutate: Mutate;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const [sourceId, setSourceId] = useState(data.sources.find((source) => source.enabled)?.id ?? "");
  const [locator, setLocator] = useState("");
  const [skill, setSkill] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [policy, setPolicy] = useState<SkillUpdatePolicy>("automatic");
  const [saving, setSaving] = useState(false);
  const source = data.sources.find((entry) => entry.id === sourceId);
  const submit = async () => {
    setSaving(true);
    const accepted = await mutate({
      type: "install",
      sourceId,
      locator: locator.trim(),
      skill: skill.trim(),
      targetIds,
      ...(policy !== "automatic" ? { policy } : {}),
    });
    setSaving(false);
    if (accepted) onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Install skill")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-6">
            <div className="space-y-3">
              <h3 className="text-sm font-medium">{t("Choose a skill")}</h3>
              <SourceSelect data={data} value={sourceId} onChange={setSourceId} />
              <label className="block space-y-2 text-sm">
                <span>
                  {t(
                    source?.kind === "local"
                      ? "Skill directory"
                      : source?.kind === "mtskills"
                        ? "Skill identifier"
                        : "Repository or URL",
                  )}
                </span>
                <Input
                  aria-label={t("Skill location")}
                  value={locator}
                  onChange={(event) => setLocator(event.target.value)}
                  placeholder={
                    source?.kind === "local"
                      ? "/path/to/skill"
                      : source?.kind === "mtskills"
                        ? "skill-name"
                        : "owner/repo"
                  }
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {t("Paths and credentials belong to the selected environment.")}
              </p>
              {source?.kind !== "local" && (
                <label className="block space-y-2 text-sm">
                  <span>
                    {t(
                      source?.kind === "mtskills" ? "Market ID (for mt)" : "Skill name (optional)",
                    )}
                  </span>
                  <Input
                    aria-label={t("Skill name")}
                    value={skill}
                    onChange={(event) => setSkill(event.target.value)}
                  />
                </label>
              )}
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t("Usage locations")}</legend>
              <Targets targets={data.targets} selected={targetIds} onChange={setTargetIds} />
              {!targetIds.length && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(
                    "Saved to the library only. Assign a location when you want an agent to use it.",
                  )}
                </p>
              )}
            </fieldset>
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-sm">{t("Automatic updates by default")}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  "Checks daily and applies changes when agents are idle. No confirmation is needed for each update.",
                )}
              </p>
              <details>
                <summary className="cursor-pointer text-xs font-medium">
                  {t("Advanced options")}
                </summary>
                <div className="mt-3">
                  <PolicySelect value={policy} onChange={setPolicy} />
                </div>
              </details>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={saving || !source?.enabled || !locator.trim()}
            onClick={() => void submit()}
          >
            {t(saving ? "Queuing..." : targetIds.length ? "Install" : "Save to library")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
function BindingDialog({
  skill,
  data,
  mutate,
  onClose,
}: {
  skill: ManagedSkill;
  data: SkillSnapshot;
  mutate: Mutate;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const [selected, setSelected] = useState(skill.bindings.map((target) => target.id));
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Usage locations")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Targets targets={data.targets} selected={selected} onChange={setSelected} />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              const ok = await mutate({
                type: "configure",
                id: skill.id,
                policy: skill.policy,
                targetIds: selected,
              });
              setSaving(false);
              if (ok) onClose();
            }}
          >
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
function OriginDialog({
  skill,
  data,
  mutate,
  onClose,
}: {
  skill: ManagedSkill;
  data: SkillSnapshot;
  mutate: Mutate;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const [sourceId, setSourceId] = useState(skill.sourceId);
  const [locator, setLocator] = useState(skill.snapshotOnly ? "" : skill.locator);
  const [name, setName] = useState(skill.requestedSkill);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Connect update source")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "Use the original upstream or an independent local directory. The managed copy cannot update itself.",
              )}
            </p>
            <SourceSelect data={data} value={sourceId} onChange={setSourceId} />
            <Input
              aria-label={t("Skill location")}
              value={locator}
              onChange={(event) => setLocator(event.target.value)}
            />
            <Input
              aria-label={t("Skill name")}
              placeholder={t("Skill name (optional)")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={saving || !locator.trim()}
            onClick={async () => {
              setSaving(true);
              const ok = await mutate({
                type: "origin",
                id: skill.id,
                sourceId,
                locator: locator.trim(),
                skill: name.trim(),
              });
              setSaving(false);
              if (ok) onClose();
            }}
          >
            {t("Save source")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
type AdoptionPreview = { skill: DiscoveredSkill; preview: SkillInspection };
function AdoptDialog({
  items,
  data,
  mutate,
  onClose,
}: {
  items: AdoptionPreview[];
  data: SkillSnapshot;
  mutate: Mutate;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const [mode, setMode] = useState<"copy" | "takeover">("takeover");
  const [selected, setSelected] = useState(items.map((item) => item.skill.path));
  const [locations, setLocations] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(items.map((item) => [item.skill.path, [...(item.skill.targetIds ?? [])]])),
  );
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Review adoption")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            <p className="text-sm text-muted-foreground">
              {t(
                "All selected skills will use automatic updates. Unknown sources stay visible until you connect an upstream.",
              )}
            </p>
            <Select value={mode} onValueChange={(value) => value && setMode(value)}>
              <SelectTrigger aria-label={t("Adoption mode")}>
                <SelectValue>
                  {t(mode === "takeover" ? "Take over selected locations" : "Copy to library")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="takeover">{t("Take over selected locations")}</SelectItem>
                <SelectItem value="copy">{t("Copy to library")}</SelectItem>
              </SelectPopup>
            </Select>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                mode === "takeover"
                  ? "Original locations are backed up before switching to managed files. You can restore them when stopping management."
                  : "Original files stay in place. Agents keep using them until you assign the managed copy to another location.",
              )}
            </p>
            {items.map(({ skill, preview }) => (
              <div key={skill.path} className="space-y-2 border-t border-border pt-4">
                <label className="flex items-start gap-3">
                  <Checkbox
                    checked={selected.includes(skill.path)}
                    disabled={preview.external}
                    aria-label={t("Adopt {name}", { name: skill.name })}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked
                          ? [...selected, skill.path]
                          : selected.filter((path) => path !== skill.path),
                      )
                    }
                  />
                  <span className="min-w-0 font-medium wrap-anywhere">{skill.name}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {preview.digest.slice(0, 12)}
                  </span>
                </label>
                <p className="text-xs text-muted-foreground wrap-anywhere">{skill.path}</p>
                <p className="text-xs">
                  {preview.external
                    ? t("Maintained externally")
                    : preview.origin
                      ? `${preview.origin.locator} · ${preview.origin.evidence}`
                      : t(
                          "Source unknown. A takeover is saved as a local snapshot until a source is connected.",
                        )}
                </p>
                {mode === "copy" ? (
                  <p className="text-xs text-muted-foreground">{t("Saved to library")}</p>
                ) : (
                  <Targets
                    targets={data.targets.filter((target) => skill.targetIds?.includes(target.id))}
                    selected={locations[skill.path] ?? []}
                    onChange={(ids) => setLocations({ ...locations, [skill.path]: ids })}
                  />
                )}
                {mode === "takeover" && !skill.targetIds?.length && (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Add this directory as a usage location to take it over, or choose Copy to library.",
                    )}
                  </p>
                )}
              </div>
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={
              saving ||
              !selected.length ||
              (mode === "takeover" && selected.some((path) => !locations[path]?.length))
            }
            onClick={async () => {
              setSaving(true);
              const operations: SkillAction[] = items
                .filter((item) => selected.includes(item.skill.path) && !item.preview.external)
                .map(({ skill, preview }) => ({
                  type: "adopt",
                  path: skill.path,
                  digest: preview.digest,
                  mode,
                  targetIds: mode === "takeover" ? (locations[skill.path] ?? []) : [],
                  ...(preview.origin ? { origin: preview.origin } : {}),
                }));
              const ok = await mutate({ type: "batch", operations });
              setSaving(false);
              if (ok) onClose();
            }}
          >
            {t(saving ? "Queuing..." : "Adopt selected ({count})", { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
function DifferenceDialog({
  skill,
  inspection,
  mutate,
  onClose,
}: {
  skill: ManagedSkill;
  inspection: SkillInspection;
  mutate: Mutate;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const changed = inspection.files.filter((file) => file.status !== "unchanged");
  const [saving, setSaving] = useState(false);
  const resolve = async (resolution: "keep" | "upstream") => {
    setSaving(true);
    const ok = await mutate({
      type: "resolve",
      id: skill.id,
      resolution,
      digest: resolution === "keep" ? inspection.digest : inspection.candidateDigest!,
    });
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Review changes for {name}", { name: skill.name })}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {t("Current {current} → candidate {candidate}", {
                current: inspection.digest.slice(0, 12),
                candidate: inspection.candidateDigest?.slice(0, 12) ?? t("None"),
              })}
            </p>
            {!changed.length && <p>{t("No file differences")}</p>}
            {changed.map((file) => (
              <details key={file.path} open={changed.length === 1}>
                <summary className="cursor-pointer text-sm wrap-anywhere">
                  {file.path} ·{" "}
                  {t(
                    file.status === "added"
                      ? "Added"
                      : file.status === "removed"
                        ? "Removed"
                        : "Changed",
                  )}
                </summary>
                <div className="mt-3 grid gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">{t("Current files")}</p>
                    <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap wrap-anywhere">
                      {file.before || t("Text preview unavailable")}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("Candidate files")}</p>
                    <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap wrap-anywhere">
                      {file.after || t("Text preview unavailable")}
                    </pre>
                  </div>
                </div>
              </details>
            ))}
            {inspection.truncated && (
              <p className="text-xs text-muted-foreground">
                {t("Large or binary files are listed without a text preview.")}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Close")}
          </Button>
          {skill.failureReason === "local-changes" && (
            <Button variant="outline" disabled={saving} onClick={() => void resolve("keep")}>
              {t("Keep local changes and pin")}
            </Button>
          )}
          <Button
            disabled={saving || !inspection.candidateDigest || skill.policy === "pinned"}
            onClick={() => void resolve("upstream")}
          >
            {t("Use candidate version")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
function SkillRow({
  skill,
  data,
  mutate,
  inspect,
  canManage,
  selected,
  onSelect,
}: {
  skill: ManagedSkill;
  data: SkillSnapshot;
  mutate: Mutate;
  inspect: Inspect;
  canManage: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const t = useUiTranslation();
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<"bindings" | "origin" | null>(null);
  const [diff, setDiff] = useState<SkillInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const detailsId = useId();
  const name = skill.description ? skill.name : skill.requestedSkill || skill.locator;
  const busy = skill.status === "fetching" || skill.status === "removing";
  const disabled = !canManage || busy;
  const failure = skillFailure(skill);
  const source = data.sources.find((entry) => entry.id === skill.sourceId);
  const viewDiff = async () => {
    setInspecting(true);
    setDiff(await inspect({ type: "diff", id: skill.id }));
    setInspecting(false);
  };
  const nextCheck = skillNextCheck(skill);
  return (
    <article className="border-b border-border py-4">
      <div className="flex items-start gap-3">
        <div className="pt-1">
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelect(checked === true)}
            aria-label={t("Select {name}", { name })}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold wrap-anywhere">{name}</h3>
            <div className="flex flex-wrap items-center gap-2">
              {skill.availableDigest && skillStatus(skill) !== "Update available" && (
                <Badge variant="info">{t("Update available")}</Badge>
              )}
              <Badge variant={failure ? "warning" : skill.availableDigest ? "info" : "secondary"}>
                {t(skillStatus(skill))}
              </Badge>
            </div>
          </div>
          {skill.description && (
            <p
              className={`${expanded ? "" : "line-clamp-1 "}mt-1 text-sm leading-relaxed text-muted-foreground wrap-anywhere`}
            >
              {skill.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{source ? skillSourceName(source, t) : skill.sourceLabel}</span>
            <span>{t(skillPolicies[skill.policy])}</span>
            <span>
              {t("{linked}/{total} locations linked", {
                linked: skill.bindings.filter((binding) => binding.status === "linked").length,
                total: skill.bindings.length,
              })}
            </span>
            {skill.activeDigest && (
              <span className="font-mono">
                {skill.versions.find((version) => version.digest === skill.activeDigest)?.label ??
                  skill.activeDigest.slice(0, 10)}
              </span>
            )}
          </div>
          {skill.bindings.length > 0 && (
            <div
              className="mt-2 space-y-1 text-xs text-muted-foreground"
              aria-label={t("Usage locations")}
            >
              {skill.bindings.map((target) => (
                <p key={target.id} className="wrap-anywhere">
                  {target.id === "directory:shared" ? t("Shared skills") : target.label} ·{" "}
                  <span className="font-mono">
                    {target.directory}/{target.entryName ?? skill.name}
                  </span>
                </p>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(skill.availableDigest || skill.failureReason === "local-changes") && (
              <Button
                size="sm"
                variant="outline"
                disabled={!canManage || inspecting}
                onClick={() => void viewDiff()}
              >
                {t("Review update")}
              </Button>
            )}
            {skill.status === "pending" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canManage}
                onClick={() => void mutate({ type: "cancel", id: skill.id })}
              >
                {t("Cancel pending update")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(!expanded)}
            >
              {t(expanded ? "Hide details" : failure ? "Review issue" : "Details")}
              {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </Button>
          </div>
          {failure && (
            <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">
              {t(failure)}
            </p>
          )}
        </div>
      </div>
      {expanded && (
        <div id={detailsId} className="mt-4 space-y-5 border-t border-border pt-4 text-sm">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "Files are managed on this environment. Start a new session or reload the provider to use changed files.",
            )}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
            <dt>{t("Update source")}</dt>
            <dd className="wrap-anywhere">{skill.locator}</dd>
            <dt>{t("Last check")}</dt>
            <dd>
              <SkillTime value={skill.checkedAt} />
            </dd>
            <dt>{t("Next check")}</dt>
            <dd>{nextCheck ? <SkillTime value={nextCheck} /> : t("Not scheduled")}</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-44">
              <PolicySelect
                value={skill.policy}
                disabled={disabled}
                onChange={(policy) => void mutate({ type: "policy", id: skill.id, policy })}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void mutate({ type: "check", id: skill.id })}
            >
              {t("Check updates")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setDialog("origin")}
            >
              {t("Connect update source")}
            </Button>
          </div>
          {skill.policyOrigin === "legacy" && (
            <p className="text-xs text-muted-foreground">
              {t("Existing policy kept. Choose a policy to confirm your preference.")}
            </p>
          )}
          {skill.choices?.length ? (
            <div className="flex flex-wrap gap-2">
              {skill.choices.map((choice) => (
                <Button
                  key={choice}
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void mutate({ type: "select", id: skill.id, skill: choice })}
                >
                  {choice}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="font-medium">{t("Usage locations")}</h4>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => setDialog("bindings")}
              >
                {t("Configure locations")}
              </Button>
            </div>
            {!skill.bindings.length && (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Saved to the library only. Assign a location when you want an agent to use it.",
                )}
              </p>
            )}
            {skill.bindings.map((target) => (
              <div key={target.id} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span>{target.label}</span>
                  <span>
                    {t(
                      target.status === "linked"
                        ? "Linked"
                        : target.status === "conflict"
                          ? "Conflict"
                          : "Missing",
                    )}
                  </span>
                </div>
                <p className="mt-1 font-mono text-muted-foreground wrap-anywhere">
                  {target.directory}
                </p>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <h4 className="font-medium">{t("Version history")}</h4>
            {skill.versions.toReversed().map((version) => (
              <div
                key={version.digest}
                className="flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <span className="font-mono">{version.label ?? version.digest.slice(0, 12)}</span>
                <span className="text-muted-foreground">
                  <SkillTime value={version.createdAt} />
                </span>
                {version.digest === skill.activeDigest ? (
                  <Badge variant="secondary">{t("Current")}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void mutate({ type: "rollback", id: skill.id, digest: version.digest })
                    }
                  >
                    {t("Restore and pin")}
                  </Button>
                )}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={async () => {
                if (
                  await requestConfirmDialog(
                    t("Stop managing {name} and keep its files at the linked locations?", { name }),
                  )
                )
                  await mutate({ type: "unmanage", id: skill.id, restore: false });
              }}
            >
              {t("Stop managing, keep files")}
            </Button>
            {Boolean(skill.backups?.length) && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={async () => {
                  if (
                    await requestConfirmDialog(
                      t("Restore the original locations of {name} and stop managing it?", { name }),
                    )
                  )
                    await mutate({ type: "unmanage", id: skill.id, restore: true });
                }}
              >
                {t("Restore original locations")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={disabled}
              onClick={async () => {
                if (
                  await requestConfirmDialog(
                    t(
                      "Uninstall {name} and its managed links? Original adoption backups will be restored.",
                      { name },
                    ),
                  )
                )
                  await mutate({ type: "remove", id: skill.id });
              }}
            >
              {t("Uninstall")}
            </Button>
          </div>
        </div>
      )}
      {dialog === "bindings" && (
        <BindingDialog skill={skill} data={data} mutate={mutate} onClose={() => setDialog(null)} />
      )}
      {dialog === "origin" && (
        <OriginDialog skill={skill} data={data} mutate={mutate} onClose={() => setDialog(null)} />
      )}
      {diff && (
        <DifferenceDialog
          skill={skill}
          inspection={diff}
          mutate={mutate}
          onClose={() => setDiff(null)}
        />
      )}
    </article>
  );
}
function SourceEditor({
  source,
  mutate,
  disabled,
}: {
  source: SkillSource;
  mutate: Mutate;
  disabled: boolean;
}) {
  const t = useUiTranslation();
  const [draft, setDraft] = useState(source);
  return (
    <form
      className="space-y-4 border-b border-border px-3 py-5 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate({ type: "source.save", source: draft });
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            {source.kind === "local" ? (
              <FolderIcon className="size-4" aria-hidden="true" />
            ) : (
              <GlobeIcon className="size-4" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold wrap-anywhere">{skillSourceName(source, t)}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {source.kind === "local"
                ? t("Local directory")
                : source.kind === "skills"
                  ? t("Vercel skills")
                  : t("Meituan mtskills")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {draft.enabled ? t("Enabled") : t("Disabled")}
          </span>
          <Switch
            aria-label={t("Enable {name}", { name: skillSourceName(source, t) })}
            checked={draft.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => {
              setDraft({ ...draft, enabled });
              void mutate({ type: "source.save", source: { ...draft, enabled } });
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          {source.health
            ? t(
                source.health.reason
                  ? skillFailureMessage(source.health.reason)
                  : source.health.detail,
              )
            : t("Not checked")}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => void mutate({ type: "source.check", sourceId: source.id })}
        >
          {t("Check availability")}
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          {t("Configuration")}
        </summary>
        <div className="mt-4 space-y-4">
          <label className="block space-y-1 text-xs">
            <span>{t("Source label")}</span>
            <Input
              aria-label={t("Source label for {name}", { name: skillSourceName(source, t) })}
              value={draft.label}
              disabled={disabled}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </label>
          {source.kind !== "local" && (
            <>
              <label className="block space-y-1 text-xs">
                <span>{t("Installer executable")}</span>
                <Input
                  aria-label={t("Installer for {name}", { name: skillSourceName(source, t) })}
                  value={draft.executable}
                  disabled={disabled}
                  placeholder={source.kind === "skills" ? "npx skills@1.7.4" : "mtskills"}
                  onChange={(event) => setDraft({ ...draft, executable: event.target.value })}
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span>{t("npm registry")}</span>
                <Input
                  aria-label={t("Registry for {name}", { name: skillSourceName(source, t) })}
                  value={draft.registry}
                  disabled={disabled}
                  onChange={(event) => setDraft({ ...draft, registry: event.target.value })}
                />
              </label>
            </>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Action
              label={`Remove source ${skillSourceName(source, t)}`}
              disabled={disabled}
              onClick={async () => {
                if (
                  await requestConfirmDialog(
                    `Remove source ${skillSourceName(source, t)}? Installed skills must be removed first.`,
                  )
                )
                  await mutate({ type: "source.remove", sourceId: source.id });
              }}
            >
              <Trash2Icon />
            </Action>
            {source.kind !== "local" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void mutate({ type: "source.prepare", sourceId: source.id })}
              >
                <ArrowDownToLineIcon />
                {t("Prepare installer")}
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={disabled || !draft.label.trim()}
            >
              {t("Save source")}
            </Button>
          </div>
        </div>
      </details>
    </form>
  );
}

function TargetEditor({ mutate, disabled }: { mutate: Mutate; disabled: boolean }) {
  const t = useUiTranslation();
  const [label, setLabel] = useState("");
  const [directory, setDirectory] = useState("");
  return (
    <form
      className="space-y-3 px-3 py-4 sm:px-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          await mutate({
            type: "target.save",
            target: { id: `custom:${directory}`, label, directory },
          })
        ) {
          setLabel("");
          setDirectory("");
        }
      }}
    >
      <label className="block space-y-1 text-xs">
        <span>{t("Agent name")}</span>
        <Input
          aria-label={t("Target agent name")}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs">
        <span>{t("Skills directory")}</span>
        <Input
          aria-label={t("Target skills directory")}
          value={directory}
          placeholder="/absolute/path/to/skills"
          onChange={(event) => setDirectory(event.target.value)}
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !label.trim() || !directory.trim()}
        type="submit"
      >
        <PlusIcon />
        {t("Add target")}
      </Button>
    </form>
  );
}

function AddSource({ mutate, disabled }: { mutate: Mutate; disabled: boolean }) {
  const t = useUiTranslation();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<SkillSource["kind"]>("skills");
  return (
    <form
      className="space-y-3 px-4 py-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          await mutate({
            type: "source.save",
            source: {
              id: randomUUID(),
              label: label.trim(),
              kind,
              enabled: true,
              executable: "",
              registry:
                kind === "mtskills"
                  ? "http://r.npm.sankuai.com"
                  : kind === "skills"
                    ? "https://registry.npmjs.org"
                    : "",
            },
          })
        )
          setLabel("");
      }}
    >
      <label className="block space-y-2 text-sm">
        <span>{t("Source name")}</span>
        <Input
          aria-label={t("New source label")}
          placeholder={t("Source name")}
          value={label}
          disabled={disabled}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <div className="space-y-2">
        <div className="text-sm">{t("Installer type")}</div>
        <Select value={kind} disabled={disabled} onValueChange={(value) => value && setKind(value)}>
          <SelectTrigger aria-label={t("Installer type")}>
            <SelectValue>
              {t(
                kind === "local"
                  ? "Local directory"
                  : kind === "skills"
                    ? "Vercel skills"
                    : "Meituan mtskills",
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {(["skills", "mtskills", "local"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {t(
                  value === "local"
                    ? "Local directory"
                    : value === "skills"
                      ? "Vercel skills"
                      : "Meituan mtskills",
                )}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={disabled || !label.trim()}>
        <PlusIcon />
        {t("Add source")}
      </Button>
    </form>
  );
}

function OperationHistory({
  data,
  mutate,
  canManage,
}: {
  data: SkillSnapshot;
  mutate: Mutate;
  canManage: boolean;
}) {
  const t = useUiTranslation();
  const jobs = data.jobs ?? [];
  const pending = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const states = {
    waiting: "Waiting for idle agents",
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return (
    <div className="border-t border-border py-4">
      {pending.length > 0 && (
        <p role="status" className="mb-3 text-sm">
          {t("{running} running · {queued} queued", {
            running: pending.filter((job) => job.status === "running").length,
            queued: pending.filter((job) => job.status === "queued").length,
          })}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          {t("Recent operations ({count})", { count: jobs.length })}
        </summary>
        <div className="mt-3 max-h-80 space-y-3 overflow-y-auto">
          {!jobs.length && (
            <p className="text-xs text-muted-foreground">{t("No operations yet")}</p>
          )}
          {jobs.toReversed().map((job) => (
            <div key={job.id} className="space-y-1 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {t(skillJobNames[job.input.type])} ·{" "}
                  {data.skills.find((skill) => skill.id === job.skillId)?.name ??
                    ("locator" in job.input
                      ? job.input.locator
                      : "path" in job.input
                        ? job.input.path
                        : "")}
                </span>
                <span>{t(states[job.status])}</span>
              </div>
              <p className="text-muted-foreground">
                <SkillTime value={job.finishedAt ?? job.createdAt} /> ·{" "}
                {t(
                  job.origin === "schedule"
                    ? "Automatic schedule"
                    : job.origin === "recovery"
                      ? "Recovery"
                      : "Requested",
                )}
                {job.beforeDigest !== job.afterDigest &&
                  job.afterDigest &&
                  ` · ${job.beforeDigest?.slice(0, 8) ?? "–"} → ${job.afterDigest.slice(0, 8)}`}
              </p>
              {job.reason && (
                <p className="text-destructive">{t(skillFailureMessage(job.reason))}</p>
              )}
              {job.status === "failed" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canManage}
                  onClick={() => void mutate(job.input)}
                >
                  {t("Retry this operation")}
                </Button>
              )}
              {(job.status === "queued" || job.status === "running" || job.status === "waiting") &&
                job.skillId &&
                ["check", "update", "rollback"].includes(job.input.type) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    onClick={() => void mutate({ type: "cancel", id: job.skillId! })}
                  >
                    {t("Cancel pending update")}
                  </Button>
                )}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
function EnvironmentSkills({
  environmentId,
  connected,
}: {
  environmentId: EnvironmentId;
  connected: boolean;
}) {
  const t = useUiTranslation();
  const tabsId = useId();
  const locale = useClientSettings((settings) => settings.uiLanguage);
  const query = useEnvironmentQuery(serverEnvironment.skills({ environmentId, input: {} }));
  const permitted = useAtomValue(serverEnvironment.mutateSkills.permissionAtom(environmentId));
  const command = useAtomCommand(serverEnvironment.mutateSkills);
  const inspectCommand = useAtomCommand(serverEnvironment.inspectSkills);
  const [tab, setTab] = useState<"skills" | "sources" | "targets">("skills");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [install, setInstall] = useState(false);
  const [previews, setPreviews] = useState<AdoptionPreview[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [batchPolicy, setBatchPolicy] = useState<SkillUpdatePolicy>("automatic");
  const mutate: Mutate = async (input) =>
    (await command({ environmentId, input }))._tag === "Success";
  const inspect: Inspect = async (input) => {
    const result = await inspectCommand({ environmentId, input });
    return result._tag === "Success" ? result.value : null;
  };
  const data = query.data;
  const canManage = permitted && connected;
  const adopt = async (skills: DiscoveredSkill[]) => {
    setPreviewing(true);
    setPreviewError(false);
    const items: AdoptionPreview[] = [];
    for (const skill of skills) {
      const preview = await inspect({ type: "adopt", path: skill.path });
      if (preview) items.push({ skill, preview });
      else setPreviewError(true);
    }
    setPreviewing(false);
    if (items.length) setPreviews(items);
  };
  if (!data)
    return (
      <p role={query.error ? "alert" : "status"} className="text-sm text-muted-foreground">
        {t(
          !connected
            ? "Environment disconnected"
            : query.error
              ? "Skills could not be loaded. Reconnect the environment and retry."
              : "Loading skills...",
        )}
      </p>
    );
  const { rows, counts } = skillRows(data, search, filter);
  const selectedManaged = data.skills.filter((skill) => selected.includes(skill.id));
  const selectedDiscovered = data.discovered.filter(
    (skill) => selected.includes(skill.identity ?? skill.path) && !skill.external,
  );
  const allVisible = rows.length > 0 && rows.every((row) => selected.includes(row.key));
  const select = (key: string, checked: boolean) =>
    setSelected(checked ? [...new Set([...selected, key])] : selected.filter((id) => id !== key));
  const batch = async (operations: SkillAction[]) => {
    if (await mutate({ type: "batch", operations })) setSelected([]);
  };
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {t("{managed} managed · {discovered} discovered", {
            managed: data.skills.length,
            discovered: data.discovered.length,
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!canManage}
            onClick={() => void mutate({ type: "refresh" })}
          >
            <RefreshCwIcon />
            {t("Refresh discoveries")}
          </Button>
          <Button size="sm" disabled={!canManage} onClick={() => setInstall(true)}>
            <PlusIcon />
            {t("Install skill")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("Checks for updates once a day")}</p>
      {!connected && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Environment disconnected. Showing cached skills from {time}.", {
            time: new Date(query.dataUpdatedAt).toLocaleString(locale),
          })}
        </p>
      )}
      {!permitted && (
        <p className="text-sm text-muted-foreground">
          {t("Read-only access. Full access is required to manage skills.")}
        </p>
      )}
      <div
        role="tablist"
        aria-label={t("Skill management")}
        className="flex gap-5 border-b border-border"
      >
        {(["skills", "sources", "targets"] as const).map((item, index, tabs) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`${tabsId}-${item}`}
            aria-controls={`${tabsId}-${item}-panel`}
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
            onKeyDown={(event) => {
              const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!offset) return;
              event.preventDefault();
              const next = (index + offset + tabs.length) % tabs.length;
              setTab(tabs[next]!);
              (
                event.currentTarget.parentElement?.children[next] as HTMLElement | undefined
              )?.focus();
            }}
            className={
              tab === item
                ? "cursor-pointer border-b-2 border-primary py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
                : "cursor-pointer border-b-2 border-transparent py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            }
          >
            {t(
              item === "skills"
                ? "Skills list"
                : item === "sources"
                  ? "Installation sources"
                  : "Usage locations",
            )}
          </button>
        ))}
      </div>
      {data.lastFailure && (
        <p role="alert" className="text-sm text-destructive">
          {t(
            data.lastFailureReason ? skillFailureMessage(data.lastFailureReason) : data.lastFailure,
          )}
        </p>
      )}
      {previewError && (
        <p role="alert" className="text-sm text-destructive">
          {t("Some previews failed. Only successfully reviewed skills can be adopted.")}
        </p>
      )}
      {tab === "skills" && (
        <div role="tabpanel" id={`${tabsId}-skills-panel`} aria-labelledby={`${tabsId}-skills`}>
          {counts.all > 0 && (
            <div className="space-y-3 border-b border-border pb-3">
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label={t("Search skills")}
                  placeholder={t("Search by name, source or location")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </InputGroup>
              <div className="flex flex-wrap items-center gap-2">
                {Object.entries(skillFilters).map(([key, label]) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={filter === key ? "secondary" : "ghost"}
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key as SkillFilter)}
                  >
                    {t(label)} {counts[key as SkillFilter]}
                  </Button>
                ))}
                <label className="ml-auto flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={allVisible}
                    aria-label={t("Select filtered skills")}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked
                          ? [...new Set([...selected, ...rows.map((row) => row.key)])]
                          : selected.filter((key) => !rows.some((row) => row.key === key)),
                      )
                    }
                  />
                  {t("Select all")}
                </label>
              </div>
            </div>
          )}
          {(selectedManaged.length > 0 || selectedDiscovered.length > 0) && (
            <div
              className="my-3 flex flex-wrap items-center gap-2 rounded-md bg-muted p-3"
              aria-label={t("Batch actions")}
            >
              <span className="text-xs">
                {t("{count} selected", {
                  count: selectedManaged.length + selectedDiscovered.length,
                })}
              </span>
              {selectedDiscovered.length > 0 && (
                <Button
                  size="sm"
                  disabled={!canManage || previewing}
                  onClick={() => void adopt(selectedDiscovered)}
                >
                  {t("Adopt selected ({count})", { count: selectedDiscovered.length })}
                </Button>
              )}
              {selectedManaged.length > 0 && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canManage}
                    onClick={() =>
                      void batch(selectedManaged.map((skill) => ({ type: "check", id: skill.id })))
                    }
                  >
                    {t("Check updates")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canManage}
                    onClick={() =>
                      void batch(
                        selectedManaged
                          .filter((skill) => skill.availableDigest && skill.policy !== "pinned")
                          .map((skill) => ({
                            type: "update",
                            id: skill.id,
                            digest: skill.availableDigest!,
                          })),
                      )
                    }
                  >
                    {t("Apply available updates")}
                  </Button>
                  <div className="min-w-40">
                    <PolicySelect
                      value={batchPolicy}
                      onChange={setBatchPolicy}
                      disabled={!canManage}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canManage}
                    onClick={() =>
                      void batch(
                        selectedManaged.map((skill) => ({
                          type: "policy",
                          id: skill.id,
                          policy: batchPolicy,
                        })),
                      )
                    }
                  >
                    {t("Set policy")}
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                {t("Clear selection")}
              </Button>
            </div>
          )}
          {!rows.length && (
            <div className="py-10 text-center">
              <p className="text-sm font-medium">
                {t(counts.all ? "No matching skills" : "No skills found in this environment")}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t(
                  counts.all
                    ? "Try a different search or clear the filters."
                    : "Install a skill, or add a usage location to discover existing skills.",
                )}
              </p>
              {counts.all > 0 && (
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSearch("");
                      setFilter("all");
                    }}
                  >
                    {t("Clear filters")}
                  </Button>
                </div>
              )}
            </div>
          )}
          {rows.map((row) =>
            row.kind === "managed" ? (
              <SkillRow
                key={row.key}
                skill={row.skill}
                data={data}
                mutate={mutate}
                inspect={inspect}
                canManage={canManage}
                selected={selected.includes(row.key)}
                onSelect={(checked) => select(row.key, checked)}
              />
            ) : (
              <article key={row.key} className="border-b border-border py-4">
                <div className="flex items-start gap-3">
                  <div className="pt-1">
                    <Checkbox
                      checked={selected.includes(row.key)}
                      disabled={row.skill.external}
                      aria-label={t("Select {name}", { name: row.name })}
                      onCheckedChange={(checked) => select(row.key, checked === true)}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold wrap-anywhere">{row.name}</h3>
                      <Badge variant="secondary">
                        {t(row.skill.external ? "Maintained externally" : "Unmanaged")}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-1 text-sm text-muted-foreground wrap-anywhere">
                      {row.skill.description}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground wrap-anywhere">
                      {(row.skill.providers ?? [row.skill.provider])
                        .map((name) =>
                          name === "Shared skills" &&
                          row.skill.targetIds?.includes("directory:shared")
                            ? t("Shared skills")
                            : name,
                        )
                        .join(", ")}{" "}
                      ·{" "}
                      {row.skill.origin?.locator ??
                        t(row.skill.external ? "Plugin or provider" : "Source unknown")}
                    </p>
                    <div
                      className="mt-2 space-y-1 text-xs text-muted-foreground"
                      aria-label={t("Usage locations")}
                    >
                      {(row.skill.paths ?? [row.skill.path]).map((path) => (
                        <p key={path} className="mt-1 font-mono wrap-anywhere">
                          {path}
                        </p>
                      ))}
                    </div>
                    <div className="mt-2">
                      {row.skill.external ? (
                        <p className="text-xs text-muted-foreground">
                          {t("Update this skill through its plugin or provider.")}
                        </p>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canManage || previewing}
                          onClick={() => void adopt([row.skill])}
                        >
                          {t(previewing ? "Preparing preview..." : "Adopt skill")}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            ),
          )}
        </div>
      )}
      {tab === "sources" && (
        <div role="tabpanel" id={`${tabsId}-sources-panel`} aria-labelledby={`${tabsId}-sources`}>
          <p className="text-sm text-muted-foreground">
            {t(
              "Sources tell managed skills where to check for changes. Enabled does not mean verified.",
            )}
          </p>
          {data.sources.map((source) => (
            <div key={source.id}>
              <p className="mt-4 text-xs text-muted-foreground">
                {t("{count} managed skills", {
                  count: data.skills.filter((skill) => skill.sourceId === source.id).length,
                })}
              </p>
              <SourceEditor
                key={`${source.id}:${source.enabled}:${source.label}:${source.executable}:${source.registry}`}
                source={source}
                mutate={mutate}
                disabled={!canManage}
              />
            </div>
          ))}
          <details className="py-4">
            <summary className="cursor-pointer text-sm font-medium">{t("Add source")}</summary>
            <AddSource mutate={mutate} disabled={!canManage} />
          </details>
        </div>
      )}
      {tab === "targets" && (
        <div role="tabpanel" id={`${tabsId}-targets-panel`} aria-labelledby={`${tabsId}-targets`}>
          <p className="text-sm text-muted-foreground">
            {t(
              "Locations are scanned for existing skills and can receive managed files. Custom paths belong to this environment.",
            )}
          </p>
          {data.targets.map((target) => {
            const bindings = data.skills.flatMap((skill) =>
              skill.bindings.filter((binding) => binding.id === target.id),
            );
            return (
              <div key={target.id} className="space-y-2 border-b border-border py-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">
                    {target.id === "directory:shared" ? t("Shared skills") : target.label}
                  </h3>
                  {data.customTargets.some((entry) => entry.id === target.id) && (
                    <Action
                      label={t("Remove location {name}", { name: target.label })}
                      disabled={!canManage}
                      onClick={() => void mutate({ type: "target.remove", targetId: target.id })}
                    >
                      <Trash2Icon />
                    </Action>
                  )}
                </div>
                <p className="font-mono text-xs text-muted-foreground wrap-anywhere">
                  {target.directory}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("{linked} linked · {conflicts} conflicts", {
                    linked: bindings.filter((binding) => binding.status === "linked").length,
                    conflicts: bindings.filter((binding) => binding.status === "conflict").length,
                  })}
                </p>
                {data.targets.filter((entry) => entry.directory === target.directory).length >
                  1 && (
                  <p className="text-xs text-muted-foreground">
                    {t("This directory is shared by multiple instances.")}
                  </p>
                )}
              </div>
            );
          })}
          <details className="py-4">
            <summary className="cursor-pointer text-sm font-medium">
              {t("Add usage location")}
            </summary>
            <TargetEditor mutate={mutate} disabled={!canManage} />
          </details>
        </div>
      )}
      <OperationHistory data={data} mutate={mutate} canManage={canManage} />
      {install && <InstallDialog data={data} mutate={mutate} onClose={() => setInstall(false)} />}
      {previews && (
        <AdoptDialog
          items={previews}
          data={data}
          mutate={mutate}
          onClose={() => setPreviews(null)}
        />
      )}
    </div>
  );
}
export function SkillsSettings() {
  const t = useUiTranslation();
  const { search } = useSettingsScope();
  const { environments: available } = useEnvironments();
  const environments = available.filter(
    (environment) => !search.machine || environment.environmentId === search.machine,
  );
  return (
    <SettingsPageContainer>
      {!environments.length && (
        <SettingsSection title={t("Skill management")}>
          <p className="text-sm text-muted-foreground">{t("No environment selected")}</p>
        </SettingsSection>
      )}
      {environments.map((environment) => (
        <SettingsSection
          key={environment.environmentId}
          title={environment.label}
          hideTitle={environments.length === 1}
          variant="plain"
        >
          <EnvironmentSkills
            environmentId={environment.environmentId}
            connected={environment.connection.phase === "connected"}
          />
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}
