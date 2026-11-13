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
  skillGroups,
  skillSelection,
  skillTargetGroups,
  skillDefaultTargetIds,
  skillStatus,
  skillFailure,
  skillNextCheck,
  skillSourceName,
  skillSourceFailure,
  type SkillFilter,
} from "@t3tools/shared/skillsUi";
import {
  ArrowDownToLineIcon,
  BanIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  FolderIcon,
  ListFilterIcon,
  MoreHorizontalIcon,
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
import { SkillCopyDialog } from "./SkillCopyDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Checkbox } from "../ui/checkbox";
import { Badge } from "../ui/badge";
import { Alert, AlertDescription } from "../ui/alert";
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
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from "../ui/popover";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";

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
  const groups = skillTargetGroups(targets).filter((group) => group.enabled);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {t("{count} locations selected", {
            count: groups.filter((group) =>
              group.targets.some((target) => selected.includes(target.id)),
            ).length,
          })}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setPaths(!paths)}>
          {t(paths ? "Hide paths" : "Show paths")}
        </Button>
      </div>
      <div className="divide-y divide-border">
        {groups.map((group) => (
          <label
            key={group.directory}
            className="flex cursor-pointer items-start gap-3 py-2.5 text-sm"
          >
            <Checkbox
              aria-label={group.targets.map((target) => target.label).join(", ")}
              checked={group.targets.some((target) => selected.includes(target.id))}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...new Set([...selected, ...group.targets.map((target) => target.id)])]
                    : selected.filter((id) => !group.targets.some((target) => target.id === id)),
                )
              }
            />
            <span className="min-w-0">
              <span className="block">
                {group.targets
                  .map((target) =>
                    target.id === "directory:shared" ? t("Shared skills") : target.label,
                  )
                  .join(" · ")}
              </span>
              {paths && (
                <span className="mt-1 block font-mono text-xs text-muted-foreground wrap-anywhere">
                  {group.directory}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Existing files at selected locations are backed up and replaced with managed links.")}
      </p>
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
  const [targetIds, setTargetIds] = useState(() => skillDefaultTargetIds(data.targets));
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
  otherSkills = [],
  data,
  mutate,
  onClose,
}: {
  skill: ManagedSkill;
  otherSkills?: ReadonlyArray<ManagedSkill>;
  data: SkillSnapshot;
  mutate: Mutate;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const skills = [skill, ...otherSkills];
  const [selected, setSelected] = useState([
    ...new Set(skills.flatMap((entry) => entry.bindings.map((target) => target.id))),
  ]);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Usage locations")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {otherSkills.length > 0 && (
            <p className="mb-3 text-xs text-muted-foreground">
              {t("Changes apply to {count} skills", { count: skills.length })}
            </p>
          )}
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
                type: "batch",
                operations: skills.map((entry) => ({
                  type: "configure",
                  id: entry.id,
                  policy: entry.policy,
                  targetIds: selected,
                })),
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
  const [selected, setSelected] = useState(items.map((item) => item.skill.path));
  const [locations, setLocations] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      items.map((item) => [
        item.skill.path,
        skillDefaultTargetIds(data.targets, item.skill.targetIds),
      ]),
    ),
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
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                "Original locations are backed up before switching to managed files. You can restore them when stopping management.",
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
                <Targets
                  targets={data.targets.filter(
                    (target) =>
                      target.id === "directory:shared" || skill.targetIds?.includes(target.id),
                  )}
                  selected={locations[skill.path] ?? []}
                  onChange={(ids) => setLocations({ ...locations, [skill.path]: ids })}
                />
                {!skill.targetIds?.length && (
                  <p className="text-xs text-muted-foreground">
                    {t("Add this directory as a usage location before adopting this skill.")}
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
              selected.some((path) => !locations[path]?.length) ||
              items.some(({ skill }) => selected.includes(skill.path) && !skill.targetIds?.length)
            }
            onClick={async () => {
              setSaving(true);
              const operations: SkillAction[] = items
                .filter((item) => selected.includes(item.skill.path) && !item.preview.external)
                .map(({ skill, preview }) => ({
                  type: "adopt",
                  path: skill.path,
                  digest: preview.digest,
                  mode: "takeover",
                  targetIds: locations[skill.path] ?? [],
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
function SkillChoices({
  skill,
  mutate,
  disabled,
}: {
  skill: ManagedSkill;
  mutate: Mutate;
  disabled: boolean;
}) {
  const t = useUiTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">{t("Choose skills to install")}</legend>
      {skill.choices?.map((choice) => (
        <label key={choice} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={selected.includes(choice)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              setSelected(
                checked ? [...selected, choice] : selected.filter((value) => value !== choice),
              )
            }
          />
          {choice}
        </label>
      ))}
      <Button
        size="sm"
        disabled={disabled || !selected.length || selected.length > 200}
        onClick={() => void mutate(skillSelection(skill, selected))}
      >
        {t("Install selected ({count})", { count: selected.length })}
      </Button>
    </fieldset>
  );
}

function SkillPackageGroup({
  group,
  search,
  children,
  data,
  mutate,
  canManage,
}: {
  group: ReturnType<typeof skillGroups>[number];
  search: string;
  children: ReactNode;
  data: SkillSnapshot;
  mutate: Mutate;
  canManage: boolean;
}) {
  const t = useUiTranslation();
  const [bindings, setBindings] = useState(false);
  const managed = group.rows.flatMap((row) => (row.kind === "managed" ? [row.skill] : []));
  if (group.rows.length === 1) return children;
  return (
    <>
      <details
        className="group/skill-package border-b border-border"
        open={search ? true : undefined}
      >
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 py-4">
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
            <ChevronDownIcon className="size-4 shrink-0 -rotate-90 group-open/skill-package:rotate-0" />
            <span className="wrap-anywhere">{group.name}</span>
            <Badge variant="secondary">
              {t("{count} subskills", { count: group.rows.length })}
            </Badge>
            {group.rows.every((row) => row.kind === "discovered" && row.skill.external) && (
              <Badge variant="secondary">{t("Maintained externally")}</Badge>
            )}
            {managed.some((skill) => skill.failureReason || skill.status === "failed") && (
              <Badge variant="warning">{t("Needs attention")}</Badge>
            )}
            {managed.some((skill) => skill.availableDigest) && (
              <Badge variant="info">{t("Update available")}</Badge>
            )}
            {managed.some((skill) => skill.status === "pending") && (
              <Badge variant="secondary">{t("Waiting for idle agents")}</Badge>
            )}
          </span>
          {managed.length > 0 && (
            <span onClick={(event) => event.stopPropagation()}>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("Package actions · {name}", { name: group.name })}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={!canManage || managed.length > 200}
                    onClick={() =>
                      void mutate({
                        type: "batch",
                        operations: managed.map((skill) => ({ type: "check", id: skill.id })),
                      })
                    }
                  >
                    {t("Check updates for all subskills")}
                  </MenuItem>
                  <MenuItem
                    disabled={!canManage || managed.length > 200}
                    onClick={() => setBindings(true)}
                  >
                    {t("Configure locations for all subskills")}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </span>
          )}
        </summary>
        <div className="pl-4 [&>article:last-child]:border-b-0">{children}</div>
      </details>
      {bindings && managed[0] && (
        <BindingDialog
          skill={managed[0]}
          otherSkills={managed.slice(1)}
          data={data}
          mutate={mutate}
          onClose={() => setBindings(false)}
        />
      )}
    </>
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
  const [detailTab, setDetailTab] = useState<"overview" | "locations" | "history">("overview");
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
              <Menu>
                <MenuTrigger
                  render={<Button size="icon-sm" variant="ghost" aria-label={t("More actions")} />}
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem disabled={disabled} onClick={() => setDialog("origin")}>
                    {t("Connect update source")}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setExpanded(true);
                      setDetailTab("history");
                    }}
                  >
                    {t("Version history")}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    disabled={disabled}
                    onClick={async () => {
                      if (
                        await requestConfirmDialog(
                          t("Stop managing {name} and keep its files at the linked locations?", {
                            name,
                          }),
                        )
                      )
                        await mutate({ type: "unmanage", id: skill.id, restore: false });
                    }}
                  >
                    {t("Stop managing, keep files")}
                  </MenuItem>
                  {Boolean(skill.backups?.length) && (
                    <MenuItem
                      disabled={disabled}
                      onClick={async () => {
                        if (
                          await requestConfirmDialog(
                            t("Restore the original locations of {name} and stop managing it?", {
                              name,
                            }),
                          )
                        )
                          await mutate({ type: "unmanage", id: skill.id, restore: true });
                      }}
                    >
                      {t("Restore original locations")}
                    </MenuItem>
                  )}
                  <MenuItem
                    variant="destructive"
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
                  </MenuItem>
                </MenuPopup>
              </Menu>
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
          </div>
          {failure && (
            <div role="alert" className="mt-2 min-w-0 text-xs leading-relaxed text-destructive">
              <p>{t(failure)}</p>
              {skill.bindings
                .filter((target) => target.status !== "linked")
                .map((target) => (
                  <p key={target.id} className="font-mono wrap-anywhere">
                    {target.label}: {target.directory}/{target.entryName ?? skill.name}
                  </p>
                ))}
              {skill.failureDiagnostics && (
                <details>
                  <summary className="cursor-pointer font-medium">{t("Error details")}</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground">
                    {skill.failureDiagnostics}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
      {expanded && (
        <div id={detailsId} className="mt-4 space-y-5 border-t border-border pt-4 text-sm">
          <div
            className="flex flex-wrap gap-4 border-b border-border"
            role="tablist"
            aria-label={t("Details")}
          >
            {(["overview", "locations", "history"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                id={`${detailsId}-${item}`}
                aria-selected={detailTab === item}
                tabIndex={detailTab === item ? 0 : -1}
                aria-controls={`${detailsId}-panel`}
                onClick={() => setDetailTab(item)}
                onKeyDown={(event) => {
                  const offset =
                    event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                  if (!offset) return;
                  event.preventDefault();
                  const tabs = ["overview", "locations", "history"] as const;
                  const next = tabs[(tabs.indexOf(item) + offset + tabs.length) % tabs.length]!;
                  setDetailTab(next);
                  document.getElementById(`${detailsId}-${next}`)?.focus();
                }}
                className={`cursor-pointer border-b-2 pb-2 text-xs ${detailTab === item ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
              >
                {t(
                  item === "overview"
                    ? "Overview"
                    : item === "locations"
                      ? "Usage locations"
                      : "Version history",
                )}
              </button>
            ))}
          </div>
          <div
            id={`${detailsId}-panel`}
            role="tabpanel"
            aria-labelledby={`${detailsId}-${detailTab}`}
          >
            {detailTab === "overview" && (
              <div className="space-y-3">
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
                {skill.policyOrigin === "legacy" && (
                  <p className="text-xs text-muted-foreground">
                    {t("Existing policy kept. Choose a policy to confirm your preference.")}
                  </p>
                )}
                {skill.choices?.length ? (
                  <SkillChoices skill={skill} mutate={mutate} disabled={disabled} />
                ) : null}
              </div>
            )}
            {detailTab === "locations" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-medium">{t("Usage locations")}</h4>
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
                {Boolean(skill.backups?.length) && (
                  <div className="space-y-2 pt-2">
                    <h4 className="font-medium">{t("Original backups")}</h4>
                    {skill.backups?.map((entry) => (
                      <div key={entry.backup} className="text-xs">
                        <p className="font-mono wrap-anywhere">{entry.original}</p>
                        <p className="mt-1 font-mono text-muted-foreground wrap-anywhere">
                          {t("Backup: {path}", { path: entry.backup })}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {detailTab === "history" && (
              <div className="space-y-2">
                <h4 className="font-medium">{t("Version history")}</h4>
                {skill.versions.toReversed().map((version) => (
                  <div
                    key={version.digest}
                    className="flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <span className="font-mono">
                      {version.label ?? version.digest.slice(0, 12)}
                    </span>
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
            )}
          </div>
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
              onClick={() => setDialog("bindings")}
            >
              {t("Configure locations")}
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
  const failure = source.health?.reason ? skillFailureMessage(source.health.reason) : null;
  const diagnostics =
    failure && source.health?.detail && source.health.detail !== failure
      ? source.health.detail
      : null;
  return (
    <form
      className="space-y-4 border-b border-border px-3 py-5 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate({ type: "source.save", source: draft });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-auto sm:flex-1">
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
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => void mutate({ type: "source.check", sourceId: source.id })}
          >
            {t("Check availability")}
          </Button>
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
      {failure ? (
        <Alert variant="error" controlAlignment="first-line">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>
            <p>{t(failure)}</p>
            {diagnostics && (
              <details className="min-w-0">
                <summary className="cursor-pointer text-xs font-medium">
                  {t("Error details")}
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                  {diagnostics}
                </pre>
              </details>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">
          {source.health ? t(source.health.detail) : t("Not checked")}
        </p>
      )}
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
  const pending = jobs.filter(
    (job) => job.status === "queued" || job.status === "running" || job.status === "waiting",
  );
  const states = {
    waiting: "Waiting for idle agents",
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return (
    <div className="py-4">
      {pending.length > 0 && (
        <p role="status" className="mb-3 text-sm">
          {t("{running} running · {queued} queued · {waiting} waiting for idle agents", {
            running: pending.filter((job) => job.status === "running").length,
            queued: pending.filter((job) => job.status === "queued").length,
            waiting: pending.filter((job) => job.status === "waiting").length,
          })}
        </p>
      )}
      <details open={pending.some((job) => job.input.type === "adopt")}>
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
                    (job.input.type === "copy"
                      ? `${job.input.name} → ${job.input.directory}`
                      : "locator" in job.input
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
                <p className="min-w-0 text-destructive">
                  {t(skillFailureMessage(job.reason))}
                  {job.diagnostics && (
                    <span className="mt-1 block max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">
                      {job.diagnostics}
                    </span>
                  )}
                </p>
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
              {job.input.type === "adopt" &&
                (job.status === "queued" || job.status === "waiting") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    onClick={() => void mutate({ type: "cancel", id: job.id })}
                  >
                    {t("Cancel adoption")}
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
  const [showExternal, setShowExternal] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [install, setInstall] = useState(false);
  const [copying, setCopying] = useState(false);
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
  const { rows, counts, hiddenExternal } = skillRows(data, search, filter, showExternal);
  const failedSource = skillSourceFailure(data);
  const selectableRows = rows.filter((row) => row.kind === "managed" || !row.skill.external);
  const selectedManaged = data.skills.filter((skill) => selected.includes(skill.id));
  const selectedDiscovered = data.discovered.filter(
    (skill) => selected.includes(skill.identity ?? skill.path) && !skill.external,
  );
  const visibleSelected = selectableRows.filter((row) => selected.includes(row.key)).length;
  const allVisible = selectableRows.length > 0 && visibleSelected === selectableRows.length;
  const select = (key: string, checked: boolean) =>
    setSelected(checked ? [...new Set([...selected, key])] : selected.filter((id) => id !== key));
  const batch = async (operations: SkillAction[]) => {
    if (await mutate({ type: "batch", operations })) setSelected([]);
  };
  return (
    <div className="min-w-0 space-y-4">
      {copying && (
        <SkillCopyDialog
          environmentId={environmentId}
          items={[
            ...selectedManaged.map((skill) => ({ name: skill.name, source: { id: skill.id } })),
            ...selectedDiscovered.map((skill) => ({
              name: skill.name,
              source: { path: skill.path },
            })),
          ]}
          onClose={() => setCopying(false)}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>
            {tab === "skills"
              ? t("Showing {count} skills", { count: rows.length })
              : t("{managed} managed · {discovered} discovered", {
                  managed: data.skills.length,
                  discovered: data.discovered.length,
                })}
          </span>
          {tab === "skills" && hiddenExternal > 0 && (
            <span className="text-xs">
              · {t("{count} external skills hidden", { count: hiddenExternal })}
            </span>
          )}
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
      <div className="flex items-center justify-between gap-3 border-b border-border">
        <div
          role="tablist"
          aria-label={t("Skill management")}
          className="flex shrink-0 gap-3 sm:gap-5"
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
        {tab === "skills" && (
          <div className="w-28 min-w-0 sm:w-56">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                size="sm"
                aria-label={t("Search skills")}
                placeholder={t("Search skills")}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSelected([]);
                }}
              />
            </InputGroup>
          </div>
        )}
      </div>
      {data.lastFailure &&
        data.lastFailureReason !== "select-skill" &&
        (tab !== "sources" || !failedSource) && (
          <Alert variant="error" controlAlignment="first-line">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>
              <p>
                {t(
                  data.lastFailureReason
                    ? skillFailureMessage(data.lastFailureReason)
                    : data.lastFailure,
                )}
              </p>
              {failedSource ? (
                <Button size="sm" variant="ghost" onClick={() => setTab("sources")}>
                  {t("Installation sources")}
                </Button>
              ) : (
                data.lastFailureDiagnostics && (
                  <details className="min-w-0">
                    <summary className="cursor-pointer text-xs font-medium">
                      {t("Error details")}
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                      {data.lastFailureDiagnostics}
                    </pre>
                  </details>
                )
              )}
            </AlertDescription>
          </Alert>
        )}
      {previewError && (
        <p role="alert" className="text-sm text-destructive">
          {t("Some previews failed. Only successfully reviewed skills can be adopted.")}
        </p>
      )}
      {tab === "skills" && (
        <div role="tabpanel" id={`${tabsId}-skills-panel`} aria-labelledby={`${tabsId}-skills`}>
          <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
            <label className="flex shrink-0 items-center gap-2 text-xs">
              <Checkbox
                checked={allVisible}
                indeterminate={visibleSelected > 0 && !allVisible}
                disabled={!selectableRows.length}
                aria-label={t("Select filtered skills")}
                onCheckedChange={(checked) =>
                  setSelected(
                    checked
                      ? [...new Set([...selected, ...selectableRows.map((row) => row.key)])]
                      : selected.filter((key) => !selectableRows.some((row) => row.key === key)),
                  )
                }
              />
              {t("Select all")}
            </label>
            {(selectedManaged.length > 0 || selectedDiscovered.length > 0) && (
              <div
                className="order-last flex w-full min-w-0 flex-wrap items-center gap-2 sm:order-none sm:w-auto sm:flex-1"
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canManage}
                  onClick={() => setCopying(true)}
                >
                  {t("Copy to environment...")}
                </Button>
                {selectedManaged.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canManage}
                      onClick={() =>
                        void batch(
                          selectedManaged.map((skill) => ({ type: "check", id: skill.id })),
                        )
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
                      {t("Update skills")}
                    </Button>
                    <div className="w-36">
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
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canManage}
                      onClick={async () => {
                        if (
                          await requestConfirmDialog(
                            t(
                              "Uninstall {count} selected skills and their managed links? Original adoption backups will be restored.",
                              {
                                count: selectedManaged.length,
                              },
                            ),
                          )
                        )
                          await batch(
                            selectedManaged.map((skill) => ({ type: "remove", id: skill.id })),
                          );
                      }}
                    >
                      <Trash2Icon />
                      {t("Uninstall")}
                    </Button>
                  </>
                )}
              </div>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      variant={filter !== "all" || showExternal ? "secondary" : "ghost"}
                      size="icon-sm"
                      aria-label={t("Filter skills")}
                    />
                  }
                >
                  <ListFilterIcon />
                </PopoverTrigger>
                <PopoverPopup align="end" width="sm">
                  <div className="space-y-3">
                    <PopoverTitle>{t("Filter skills")}</PopoverTitle>
                    <div className="flex flex-col items-start gap-1">
                      {Object.entries(skillFilters).map(([key, label]) => (
                        <Button
                          key={key}
                          size="sm"
                          variant={filter === key ? "secondary" : "ghost"}
                          aria-pressed={filter === key}
                          onClick={() => {
                            setFilter(key as SkillFilter);
                            setSelected([]);
                          }}
                        >
                          {t(label)} {counts[key as SkillFilter]}
                        </Button>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 border-t border-border pt-3 text-xs">
                      <Checkbox
                        checked={showExternal}
                        onCheckedChange={(checked) => {
                          setShowExternal(checked === true);
                          setSelected([]);
                        }}
                      />
                      {t("Show externally maintained skills")}
                    </label>
                  </div>
                </PopoverPopup>
              </Popover>
            </div>
          </div>
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
          {skillGroups(rows).map((group) => (
            <SkillPackageGroup
              key={group.key}
              group={group}
              search={search}
              data={data}
              mutate={mutate}
              canManage={canManage}
            >
              {group.rows.map((row) =>
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
                        {row.skill.external && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {t("Update this skill through its plugin or provider.")}
                          </p>
                        )}
                      </div>
                    </div>
                  </article>
                ),
              )}
            </SkillPackageGroup>
          ))}
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
          {skillTargetGroups(data.targets).map((group) => {
            const name = group.targets
              .map((target) =>
                target.id === "directory:shared" ? t("Shared skills") : target.label,
              )
              .join(" · ");
            const targetIds = new Set(group.targets.map((target) => target.id));
            const bindings = data.skills
              .map((skill) =>
                skill.bindings.filter(
                  (binding) => targetIds.has(binding.id) || binding.directory === group.directory,
                ),
              )
              .filter((entries) => entries.length);
            return (
              <div key={group.directory} className="space-y-2 border-b border-border py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">{name}</h3>
                    {group.targets.length > 1 && (
                      <Badge variant="secondary">{t("Shared directory")}</Badge>
                    )}
                    {!group.enabled && (
                      <Badge variant="secondary">
                        <BanIcon />
                        {t("Disabled")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {!group.shared && !group.hasSkills && (
                      <Action
                        label={t("Remove location {name}", { name })}
                        disabled={!canManage}
                        onClick={() =>
                          void mutate({ type: "target.remove", targetId: group.targets[0]!.id })
                        }
                      >
                        <Trash2Icon />
                      </Action>
                    )}
                    {(group.hasSkills || !group.enabled) && (
                      <Switch
                        aria-label={t("Enable location {name}", { name })}
                        checked={group.enabled}
                        disabled={!canManage}
                        onCheckedChange={(enabled) =>
                          void mutate({
                            type: "target.configure",
                            targetId: group.targets[0]!.id,
                            enabled,
                          })
                        }
                      />
                    )}
                  </div>
                </div>
                <p className="font-mono text-xs text-muted-foreground wrap-anywhere">
                  {group.directory}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("{linked} linked · {conflicts} conflicts", {
                    linked: bindings.filter(
                      (entries) =>
                        entries.some((binding) => binding.status === "linked") &&
                        !entries.some((binding) => binding.status === "conflict"),
                    ).length,
                    conflicts: bindings.filter((entries) =>
                      entries.some((binding) => binding.status === "conflict"),
                    ).length,
                  })}
                </p>
                {group.targets.length > 1 && (
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
