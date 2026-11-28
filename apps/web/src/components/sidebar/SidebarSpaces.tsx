import {
  normalizeSidebarSpaceName,
  sidebarSpaceInitial,
  sidebarSpaceProjectKey,
  sidebarSpaceRgb,
  type SidebarSpace,
} from "@t3tools/client-runtime/sidebar-spaces";
import { type ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  EllipsisIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import { type CSSProperties, useId, useState } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { pressLightProps } from "../../lib/pressLight";
import { randomUUID } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  EMPTY_SIDEBAR_SPACES,
  SIDEBAR_SPACE_DEFINITIONS,
  SidebarSpaceDefinitions,
  readSpaceSessionStorage,
  selectActiveSidebarSpace,
  useActiveSidebarSpaceId,
} from "./sidebarSpaceSession";

const RETURNS = "t3code:sidebar:space-return";
/* More dots than this read as confetti, so the rest sit behind an overflow menu. */
const RAIL_DOTS = 3;
const ReturnRefs = Schema.fromJsonString(Schema.Record(Schema.String, ScopedThreadRef));
const decodeReturns = Schema.decodeUnknownOption(ReturnRefs);
const encodeReturns = Schema.encodeSync(ReturnRefs);
let returnsCache: Readonly<Record<string, ScopedThreadRef>> | undefined;
function readReturnRefs(): Readonly<Record<string, ScopedThreadRef>> {
  return (
    returnsCache ?? Option.getOrElse(decodeReturns(readSpaceSessionStorage(RETURNS)), () => ({}))
  );
}

/** Sets a Space's ambient colour. Tokens derived from it must be declared on this element or below. */
function spaceStyle(space: Pick<SidebarSpace, "id">): CSSProperties {
  return { "--space-rgb": sidebarSpaceRgb(space) } as CSSProperties;
}

export function SpaceAvatar({
  space,
  className,
}: {
  readonly space: Pick<SidebarSpace, "id" | "name">;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-space text-2xs leading-none font-bold text-white ring-1 ring-black/15",
        className,
      )}
      style={spaceStyle(space)}
    >
      {sidebarSpaceInitial(space.name)}
    </span>
  );
}

export function useSidebarSpaces() {
  const [spaces, setSpaces] = useLocalStorage(
    SIDEBAR_SPACE_DEFINITIONS,
    EMPTY_SIDEBAR_SPACES,
    SidebarSpaceDefinitions,
  );
  const id = useActiveSidebarSpaceId();
  return {
    spaces,
    active: spaces.find((space) => space.id === id) ?? null,
    select: selectActiveSidebarSpace,
    save(space: SidebarSpace) {
      setSpaces((previous) =>
        previous.some(({ id }) => id === space.id)
          ? previous.map((item) => (item.id === space.id ? space : item))
          : [...previous, space],
      );
    },
    remove(id: string) {
      setSpaces((previous) => previous.filter((item) => item.id !== id));
    },
    rememberThread(id: string, thread: ScopedThreadRef) {
      const previous = readReturnRefs();
      const stored = previous[id];
      if (stored?.environmentId === thread.environmentId && stored.threadId === thread.threadId)
        return;
      returnsCache = { ...previous, [id]: thread };
      try {
        sessionStorage.setItem(RETURNS, encodeReturns(returnsCache));
      } catch {
        /* Retain in memory. */
      }
    },
    restoreThread(id: string) {
      return readReturnRefs()[id];
    },
  };
}

export type SpaceProjectOption = { readonly ref: ScopedProjectRef; readonly label: string };

/** The Space pill under the title bar: identity of the current scope and the switcher for all of them. */
export function SidebarSpacePicker({
  spaces,
  active,
  onSelect,
  onEdit,
  onCreate,
}: {
  readonly spaces: readonly SidebarSpace[];
  readonly active: SidebarSpace | null;
  readonly onSelect: (space: SidebarSpace | null) => void;
  readonly onEdit: () => void;
  readonly onCreate: () => void;
}) {
  const t = useUiTranslation();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant={active === null ? "ghost" : "tile"}
            size="pill"
            aria-label={t("Switch Space")}
            {...pressLightProps}
            style={active === null ? undefined : spaceStyle(active)}
          >
            {active === null ? (
              <FolderIcon aria-hidden className="text-muted-foreground" />
            ) : (
              <SpaceAvatar space={active} />
            )}
            <span className="truncate">{active?.name ?? t("All projects")}</span>
            {active === null ? null : (
              <span aria-hidden className="text-2xs font-medium text-muted-foreground tabular-nums">
                {active.projectRefs.length}
              </span>
            )}
            <ChevronsUpDownIcon aria-hidden className="ml-auto text-muted-foreground" />
          </Button>
        }
      />
      <MenuPopup align="start" className="min-w-(--anchor-width)">
        <MenuItem onClick={() => onSelect(null)}>
          <FolderIcon className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t("All projects")}</span>
          {active === null ? <CheckIcon /> : null}
        </MenuItem>
        {spaces.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>{t("Spaces")}</MenuGroupLabel>
            {spaces.map((space) => (
              <MenuItem key={space.id} style={spaceStyle(space)} onClick={() => onSelect(space)}>
                <SpaceAvatar space={space} className="size-5 rounded-md text-3xs" />
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
                {space.id === active?.id ? (
                  <CheckIcon />
                ) : (
                  <span className="text-2xs text-muted-foreground tabular-nums">
                    {space.projectRefs.length}
                  </span>
                )}
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={active === null ? onCreate : onEdit}>
          <PencilIcon className="text-muted-foreground" />
          {active === null ? t("New Space") : t("Edit Space")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The rail along the bottom: every Space as a quiet colour dot, and a glass "+" that only creates
 * Spaces. It is never the new-thread button.
 */
export function SidebarSpaceFooter({
  spaces,
  active,
  onSelect,
  onCreate,
}: {
  readonly spaces: readonly SidebarSpace[];
  readonly active: SidebarSpace | null;
  readonly onSelect: (space: SidebarSpace | null) => void;
  readonly onCreate: () => void;
}) {
  const t = useUiTranslation();
  const firstSpaces = spaces.slice(0, RAIL_DOTS);
  const visibleSpaces =
    active && !firstSpaces.some((space) => space.id === active.id)
      ? [...firstSpaces.slice(0, RAIL_DOTS - 1), active]
      : firstSpaces;
  const otherSpaces = spaces.filter((space) => !visibleSpaces.some(({ id }) => id === space.id));
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div role="group" aria-label={t("Spaces")} className="flex min-w-0 flex-1 items-center gap-1">
        <RailDot
          label={t("All projects")}
          active={active === null}
          style={{ "--space-rgb": "138, 145, 160" } as CSSProperties}
          onClick={() => onSelect(null)}
        />
        {visibleSpaces.map((space) => (
          <RailDot
            key={space.id}
            label={space.name}
            active={space.id === active?.id}
            style={spaceStyle(space)}
            onClick={() => onSelect(space)}
          />
        ))}
        {otherSpaces.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label={t("More Spaces")} />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup side="top" align="start">
              {otherSpaces.map((space) => (
                <MenuItem key={space.id} style={spaceStyle(space)} onClick={() => onSelect(space)}>
                  <SpaceAvatar space={space} className="size-5 rounded-md text-3xs" />
                  {space.name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="tile"
              size="icon"
              aria-label={t("New Space")}
              {...pressLightProps}
              onClick={onCreate}
            >
              <PlusIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">{t("New Space")}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function RailDot({
  label,
  active,
  style,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly style: CSSProperties | undefined;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
            style={style}
            className="group/dot grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-sidebar-row-selected"
          >
            <span
              aria-hidden
              className="size-2 rounded-full bg-sidebar-muted-foreground transition-colors group-hover/dot:bg-space group-aria-pressed/dot:bg-space group-focus-visible/dot:bg-space motion-reduce:transition-none"
            />
          </button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarSpaceEditor({
  editing,
  spaces,
  projects,
  onSave,
  onRemove,
  onClose,
}: {
  editing: SidebarSpace | null;
  spaces: readonly SidebarSpace[];
  projects: readonly SpaceProjectOption[];
  onSave: (space: SidebarSpace) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const nameId = useId();
  // The id is fixed up front so the avatar keeps its colour from the first keystroke to the save.
  const [id] = useState(() => editing?.id ?? randomUUID());
  const [name, setName] = useState(editing?.name ?? "");
  const [selected, setSelected] = useState(
    () => new Map(editing?.projectRefs.map((ref) => [sidebarSpaceProjectKey(ref), ref])),
  );
  const nameKey = normalizeSidebarSpaceName(name);
  const duplicate = spaces.some(
    (space) => space.id !== editing?.id && normalizeSidebarSpaceName(space.name) === nameKey,
  );
  const avatar = { id, name };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!nameKey || duplicate) return;
            onSave({ id, name: name.trim(), projectRefs: [...selected.values()] });
          }}
        >
          <DialogHeader className="flex-row items-center">
            <SpaceAvatar space={avatar} className="mr-3 size-9 rounded-xl text-sm" />
            <div className="min-w-0">
              <DialogTitle>{editing ? t("Edit Space") : t("New Space")}</DialogTitle>
              <DialogDescription>
                {t("Choose which projects to show in this Space.")}
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor={nameId}>{t("Space name")}</Label>
              <Input
                id={nameId}
                maxLength={80}
                value={name}
                aria-invalid={duplicate}
                onChange={(event) => setName(event.target.value)}
              />
              {duplicate ? (
                <p role="status" className="text-sm text-destructive">
                  {t("A Space with this name already exists.")}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{t("Projects")}</span>
              <div className="flex max-h-56 flex-col gap-0.5 overflow-auto">
                {projects.map(({ ref, label }) => {
                  const key = sidebarSpaceProjectKey(ref);
                  return (
                    <label
                      className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-accent"
                      key={key}
                    >
                      <Checkbox
                        checked={selected.has(key)}
                        onCheckedChange={() => {
                          setSelected((current) => {
                            const next = new Map(current);
                            if (next.has(key)) next.delete(key);
                            else next.set(key, ref);
                            return next;
                          });
                        }}
                      />
                      <span className="break-all">{label}</span>
                    </label>
                  );
                })}
              </div>
              {[...selected.keys()].some(
                (key) => !projects.some(({ ref }) => sidebarSpaceProjectKey(ref) === key),
              ) ? (
                <p className="text-sm text-muted-foreground">
                  {t("Unavailable projects stay in this Space.")}
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter className="sm:justify-between">
            {editing ? (
              <Button
                type="button"
                variant="ghost-destructive"
                className="sm:mr-auto"
                onClick={() => onRemove(editing.id)}
              >
                <TrashIcon aria-hidden="true" />
                {t("Delete Space")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!nameKey || duplicate}>
              {t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function SidebarSpaceNewThread({
  projects,
  onSelect,
  onClose,
}: {
  projects: readonly SpaceProjectOption[];
  onSelect: (ref: ScopedProjectRef) => void;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Choose a project")}</DialogTitle>
          <DialogDescription>{t("Start a thread in this Space.")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-60 flex-col items-start gap-0.5 overflow-auto px-4">
          {projects.map(({ ref, label }) => (
            <Button
              key={sidebarSpaceProjectKey(ref)}
              variant="ghost"
              light
              {...pressLightProps}
              className="w-full justify-start"
              onClick={() => onSelect(ref)}
            >
              <FolderIcon aria-hidden className="text-muted-foreground" />
              {label}
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
