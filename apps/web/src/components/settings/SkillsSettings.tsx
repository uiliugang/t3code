import { useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ManagedSkill,
  SkillMutation,
  SkillSnapshot,
  SkillSource,
  SkillTarget,
  SkillUpdatePolicy,
} from "@t3tools/contracts";
import {
  ArrowDownToLineIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FolderInputIcon,
  LinkIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestConfirmDialog } from "../../confirmDialog";
import { randomUUID } from "../../lib/utils";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
const policies: Record<SkillUpdatePolicy, string> = {
  manual: "Manual",
  notify: "Check daily",
  automatic: "Update daily",
  pinned: "Pinned",
};

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
            size="icon-sm"
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

function PolicySelect({
  value,
  onChange,
  disabled,
}: {
  value: SkillUpdatePolicy;
  onChange: (policy: SkillUpdatePolicy) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)} disabled={disabled}>
      <SelectTrigger aria-label="Update policy">
        <SelectValue>{policies[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {Object.entries(policies).map(([key, label]) => (
          <SelectItem key={key} value={key}>
            {label}
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
  return (
    <div className="space-y-3">
      {targets.map((target) => (
        <label key={target.id} className="flex items-start gap-3 text-sm">
          <Checkbox
            aria-label={target.label}
            checked={selected.includes(target.id)}
            onCheckedChange={(checked) =>
              onChange(
                checked ? [...selected, target.id] : selected.filter((id) => id !== target.id),
              )
            }
          />
          <span className="min-w-0">
            <span className="block">{target.label}</span>
            <span className="block break-all text-xs text-muted-foreground">
              {target.directory}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

function InstallDialog({
  data,
  mutate,
  onClose,
  localPath,
}: {
  data: SkillSnapshot;
  mutate: Mutate;
  onClose: () => void;
  localPath?: string;
}) {
  const [sourceId, setSourceId] = useState(
    data.sources.find((source) => source.enabled && (!localPath || source.kind === "local"))?.id ??
      "",
  );
  const [locator, setLocator] = useState(localPath ?? "");
  const [skill, setSkill] = useState("");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [policy, setPolicy] = useState<SkillUpdatePolicy>("manual");
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
      policy,
    });
    setSaving(false);
    if (accepted) onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Install skill</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            <div className="block space-y-2 text-sm">
              <span>Source</span>
              <Select value={sourceId} onValueChange={(value) => value && setSourceId(value)}>
                <SelectTrigger aria-label="Skill source">
                  <SelectValue>{source?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {data.sources
                    .filter((entry) => entry.enabled)
                    .map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.label}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
            </div>
            <label className="block space-y-2 text-sm">
              <span>
                {source?.kind === "local"
                  ? "Skill directory"
                  : "Repository, URL or skill identifier"}
              </span>
              <Input
                aria-label="Skill location"
                value={locator}
                onChange={(event) => setLocator(event.target.value)}
                placeholder={
                  source?.kind === "local"
                    ? "/path/to/skill"
                    : source?.kind === "mtskills"
                      ? "mtsso-skills-official"
                      : "owner/repo"
                }
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span>Skill name / market ID (optional)</span>
              <Input
                aria-label="Skill name"
                value={skill}
                onChange={(event) => setSkill(event.target.value)}
              />
            </label>
            <div className="space-y-2">
              <div className="text-sm">Update policy</div>
              <PolicySelect value={policy} onChange={setPolicy} />
            </div>
            <fieldset className="space-y-3">
              <legend className="mb-3 text-sm">Agent targets</legend>
              <Targets targets={data.targets} selected={targetIds} onChange={setTargetIds} />
            </fieldset>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving || !source?.enabled || !locator.trim()}
            onClick={() => void submit()}
          >
            <ArrowDownToLineIcon />
            {saving ? "Queuing..." : "Install"}
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
  const [selected, setSelected] = useState(skill.bindings.map((target) => target.id));
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Agent targets</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Targets targets={data.targets} selected={selected} onChange={setSelected} />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              const accepted = await mutate({
                type: "configure",
                id: skill.id,
                policy: skill.policy,
                targetIds: selected,
              });
              setSaving(false);
              if (accepted) onClose();
            }}
          >
            Save
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
  canManage,
}: {
  skill: ManagedSkill;
  data: SkillSnapshot;
  mutate: Mutate;
  canManage: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [binding, setBinding] = useState(false);
  const displayName = skill.description ? skill.name : skill.requestedSkill || skill.locator;
  const busy = skill.status === "fetching" || skill.status === "removing";
  const disabled = !canManage || busy;
  const status =
    skill.status === "fetching"
      ? "Fetching package"
      : skill.status === "pending"
        ? "Waiting for idle agents"
        : skill.status === "failed"
          ? "Needs attention"
          : skill.status === "removing"
            ? "Removing"
            : skill.availableDigest
              ? "Update available"
              : "Installed";
  return (
    <article className="border-b border-border px-3 py-4 sm:px-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-all text-sm font-medium">{displayName}</h3>
          <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
            {skill.description}
          </p>
        </div>
        <div className="max-w-40 shrink-0">
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <Badge variant="outline">
                <span className="max-w-32 truncate">{skill.sourceLabel}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipPopup>{skill.sourceLabel}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={
            skill.status === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {status}
        </span>
        <span className="text-xs text-muted-foreground">
          {skill.bindings.filter((target) => target.status === "linked").length}/
          {skill.bindings.length} linked
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Action
            label={`Check updates for ${displayName}`}
            disabled={disabled}
            onClick={() => void mutate({ type: "check", id: skill.id })}
          >
            <RefreshCwIcon />
          </Action>
          <Action
            label={`Update ${displayName}`}
            disabled={disabled}
            onClick={() => void mutate({ type: "update", id: skill.id })}
          >
            <ArrowDownToLineIcon />
          </Action>
          <Action
            label={`Manage targets for ${displayName}`}
            disabled={disabled}
            onClick={() => setBinding(true)}
          >
            <LinkIcon />
          </Action>
          <Action
            label={`Remove ${displayName}`}
            disabled={disabled}
            onClick={async () => {
              if (await requestConfirmDialog(`Remove ${displayName} and its managed agent links?`))
                await mutate({ type: "remove", id: skill.id });
            }}
          >
            <Trash2Icon />
          </Action>
          <Action
            label={`${expanded ? "Hide" : "Show"} details for ${displayName}`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </Action>
        </div>
      </div>
      {skill.failure && (
        <p role="alert" className="mt-2 break-words text-xs text-destructive">
          {skill.failure}
        </p>
      )}
      {expanded && (
        <div className="mt-4 space-y-4 text-xs">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">Source</dt>
            <dd className="break-all">{skill.locator}</dd>
            <dt className="text-muted-foreground">Installer</dt>
            <dd>{data.sources.find((entry) => entry.id === skill.sourceId)?.kind ?? "Unknown"}</dd>
            <dt className="text-muted-foreground">Checked</dt>
            <dd>{skill.checkedAt ? new Date(skill.checkedAt).toLocaleString() : "Never"}</dd>
          </dl>
          <div className="max-w-60">
            <PolicySelect
              value={skill.policy}
              disabled={disabled}
              onChange={(policy) =>
                void mutate({
                  type: "configure",
                  id: skill.id,
                  policy,
                  targetIds: skill.bindings.map((target) => target.id),
                })
              }
            />
          </div>
          {skill.bindings.map((target) => (
            <div key={target.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div>{target.label}</div>
                <div className="break-all text-muted-foreground">{target.directory}</div>
              </div>
              <Badge variant={target.status === "linked" ? "success" : "warning"}>
                {target.status}
              </Badge>
            </div>
          ))}
          <div className="space-y-2">
            {skill.versions.toReversed().map((version) => (
              <div key={version.digest} className="flex items-center justify-between gap-2">
                <span className="font-mono">{version.digest.slice(0, 12)}</span>
                <span className="text-muted-foreground">
                  {new Date(version.createdAt).toLocaleDateString()}
                </span>
                {version.digest === skill.activeDigest ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Action
                    label={`Restore ${version.digest.slice(0, 12)}`}
                    disabled={disabled}
                    onClick={() =>
                      void mutate({ type: "rollback", id: skill.id, digest: version.digest })
                    }
                  >
                    <RotateCcwIcon />
                  </Action>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {binding && (
        <BindingDialog
          skill={skill}
          data={data}
          mutate={mutate}
          onClose={() => setBinding(false)}
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
  const [draft, setDraft] = useState(source);
  return (
    <form
      className="space-y-3 border-b border-border px-3 py-4 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void mutate({ type: "source.save", source: draft });
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{source.label}</span>
        <Switch
          aria-label={`Enable ${source.label}`}
          checked={draft.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => {
            setDraft({ ...draft, enabled });
            void mutate({ type: "source.save", source: { ...draft, enabled } });
          }}
        />
      </div>
      <label className="block space-y-1 text-xs">
        <span>Source label</span>
        <Input
          aria-label={`${source.label} label`}
          value={draft.label}
          disabled={disabled}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        />
      </label>
      {source.kind !== "local" && (
        <>
          <label className="block space-y-1 text-xs">
            <span>Installer executable</span>
            <Input
              aria-label={`${source.label} executable`}
              value={draft.executable}
              disabled={disabled}
              placeholder={source.kind === "skills" ? "npx skills@1.7.4" : "mtskills"}
              onChange={(event) => setDraft({ ...draft, executable: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span>npm registry</span>
            <Input
              aria-label={`${source.label} registry`}
              value={draft.registry}
              disabled={disabled}
              onChange={(event) => setDraft({ ...draft, registry: event.target.value })}
            />
          </label>
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Action
          label={`Remove source ${source.label}`}
          disabled={disabled}
          onClick={async () => {
            if (
              await requestConfirmDialog(
                `Remove source ${source.label}? Installed skills must be removed first.`,
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
            Prepare installer
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={disabled || !draft.label.trim()}
        >
          Save source
        </Button>
      </div>
    </form>
  );
}

function TargetEditor({ mutate, disabled }: { mutate: Mutate; disabled: boolean }) {
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
        <span>Agent name</span>
        <Input
          aria-label="Target agent name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs">
        <span>Skills directory</span>
        <Input
          aria-label="Target skills directory"
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
        Add target
      </Button>
    </form>
  );
}

function AddSource({ mutate, disabled }: { mutate: Mutate; disabled: boolean }) {
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
      <Input
        aria-label="New source label"
        placeholder="Source name"
        value={label}
        disabled={disabled}
        onChange={(event) => setLabel(event.target.value)}
      />
      <Select value={kind} disabled={disabled} onValueChange={(value) => value && setKind(value)}>
        <SelectTrigger aria-label="Installer type">
          <SelectValue>{kind}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {(["skills", "mtskills", "local"] as const).map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button type="submit" size="sm" variant="outline" disabled={disabled || !label.trim()}>
        <PlusIcon />
        Add source
      </Button>
    </form>
  );
}

function EnvironmentSkills({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(serverEnvironment.skills({ environmentId, input: {} }));
  const permitted = useAtomValue(serverEnvironment.mutateSkills.permissionAtom(environmentId));
  const command = useAtomCommand(serverEnvironment.mutateSkills);
  const [tab, setTab] = useState<"installed" | "sources" | "targets">("installed");
  const [search, setSearch] = useState("");
  const [install, setInstall] = useState<{ localPath?: string } | null>(null);
  const mutate: Mutate = async (input) =>
    (await command({ environmentId, input }))._tag === "Success";
  const data = query.data;
  const canManage = permitted && !data?.operation;
  if (query.error)
    return (
      <p role="alert" className="px-4 text-sm text-destructive">
        {query.error}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="px-4 text-sm text-muted-foreground">
        Loading skills...
      </p>
    );
  const filtered = data.skills.filter((skill) =>
    `${skill.name} ${skill.description} ${skill.sourceLabel}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 pb-3 sm:px-4">
        <div role="tablist" aria-label="Skill management" className="flex gap-4">
          {(["installed", "sources", "targets"] as const).map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === item}
              tabIndex={tab === item ? 0 : -1}
              onKeyDown={(event) => {
                const tabs = ["installed", "sources", "targets"] as const;
                const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!offset) return;
                event.preventDefault();
                const next = (tabs.indexOf(item) + offset + tabs.length) % tabs.length;
                setTab(tabs[next]!);
                (
                  event.currentTarget.parentElement?.children[next] as HTMLElement | undefined
                )?.focus();
              }}
              key={item}
              onClick={() => setTab(item)}
              className={
                tab === item
                  ? "border-b-2 border-primary py-2 text-sm font-medium"
                  : "py-2 text-sm text-muted-foreground"
              }
            >
              {item === "installed" ? "Installed" : item === "sources" ? "Sources" : "Targets"}
            </button>
          ))}
        </div>
        <Button size="sm" disabled={!canManage} onClick={() => setInstall({})}>
          <PlusIcon />
          Install skill
        </Button>
      </div>
      {data.lastFailure && (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {data.lastFailure}
        </p>
      )}
      {data.operation && (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          {data.operation === "source.prepare"
            ? "Preparing installer..."
            : "Applying skill changes..."}
        </p>
      )}
      {tab === "installed" && (
        <div role="tabpanel">
          <div className="px-3 py-3 sm:px-4">
            <Input
              aria-label="Search installed skills"
              placeholder="Search skills"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {filtered.length === 0 && (
            <p className="px-4 py-8 text-sm text-muted-foreground">
              {search ? "No matching skills" : "No managed skills installed"}
            </p>
          )}
          {filtered.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              data={data}
              mutate={mutate}
              canManage={canManage}
            />
          ))}
          {data.discovered.length > 0 && (
            <details className="px-3 py-4 sm:px-4">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Unmanaged skills ({data.discovered.length})
              </summary>
              <div className="mt-3 space-y-3">
                {data.discovered
                  .filter((skill) => skill.name.toLowerCase().includes(search.toLowerCase()))
                  .map((skill) => (
                    <div
                      key={`${skill.provider}:${skill.path}`}
                      className="flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="break-all text-sm">{skill.name}</div>
                        <div className="break-all text-xs text-muted-foreground">
                          {skill.provider} · {skill.path}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline">Unknown source</Badge>
                        <Action
                          label={`Import ${skill.name}`}
                          disabled={!canManage}
                          onClick={() =>
                            setInstall({ localPath: skill.path.replace(/[/\\]SKILL\.md$/i, "") })
                          }
                        >
                          <FolderInputIcon />
                        </Action>
                      </div>
                    </div>
                  ))}
              </div>
            </details>
          )}
        </div>
      )}
      {tab === "sources" && (
        <div role="tabpanel">
          {data.sources.map((source) => (
            <SourceEditor
              key={`${source.id}:${source.enabled}:${source.label}:${source.executable}:${source.registry}`}
              source={source}
              mutate={mutate}
              disabled={!canManage}
            />
          ))}
          <AddSource mutate={mutate} disabled={!canManage} />
        </div>
      )}
      {tab === "targets" && (
        <div role="tabpanel">
          {data.targets.map((target) => (
            <div key={target.id} className="border-b border-border px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span>{target.label}</span>
                {data.customTargets.some((entry) => entry.id === target.id) && (
                  <Action
                    label={`Remove target ${target.label}`}
                    disabled={!canManage}
                    onClick={() => void mutate({ type: "target.remove", targetId: target.id })}
                  >
                    <Trash2Icon />
                  </Action>
                )}
              </div>
              <div className="break-all text-xs text-muted-foreground">{target.directory}</div>
            </div>
          ))}
          <TargetEditor mutate={mutate} disabled={!canManage} />
        </div>
      )}
      {install && (
        <InstallDialog data={data} mutate={mutate} onClose={() => setInstall(null)} {...install} />
      )}
    </>
  );
}

export function SkillsSettings() {
  const { environments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environments.length === 0 && (
        <SettingsSection title="Skills">
          <p className="px-4 py-6 text-sm text-muted-foreground">No environment selected</p>
        </SettingsSection>
      )}
      {environments.map((environment) => (
        <SettingsSection
          key={environment.environmentId}
          title={`Skills · ${environment.label}`}
          variant="plain"
        >
          {environment.connection.phase === "connected" ? (
            <EnvironmentSkills environmentId={environment.environmentId} />
          ) : (
            <p className="px-4 text-sm text-muted-foreground">Environment disconnected</p>
          )}
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}
