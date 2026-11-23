import {
  normalizeSidebarSpaceName,
  sidebarSpaceProjectKey,
  type SidebarSpace,
} from "@t3tools/client-runtime/sidebar-spaces";
import { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { EllipsisIcon, FolderIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { randomUUID } from "../../lib/utils";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DEFINITIONS = "t3code:sidebar:spaces";
const ACTIVE = "t3code:sidebar:active-space";
const RETURNS = "t3code:sidebar:space-return";
const ALL = "all";
const EMPTY: readonly SidebarSpace[] = [];
const Definitions = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    projectRefs: Schema.Array(ScopedProjectRef),
  }),
);
const ReturnRefs = Schema.fromJsonString(Schema.Record(Schema.String, ScopedThreadRef));
const decodeReturns = Schema.decodeUnknownOption(ReturnRefs);
const encodeReturns = Schema.encodeSync(ReturnRefs);
let activeCache: string | null | undefined;
function readStorage(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readActiveSidebarSpaceId(): string | null {
  return activeCache === undefined ? readStorage(ACTIVE) : activeCache;
}

let switchSidebarSpace: ((id: string | null) => void) | null = null;
let openNewThreadInSpace: (() => void) | null = null;
export const sidebarSpaceCommands = {
  subscribeSwitch(handler: (id: string | null) => void) {
    switchSidebarSpace = handler;
    return () => {
      if (switchSidebarSpace === handler) switchSidebarSpace = null;
    };
  },
  switch(id: string | null) {
    switchSidebarSpace?.(id);
  },
  subscribe(handler: () => void) {
    openNewThreadInSpace = handler;
    return () => {
      if (openNewThreadInSpace === handler) openNewThreadInSpace = null;
    };
  },
  newThread() {
    if (readActiveSidebarSpaceId() === null) return false;
    openNewThreadInSpace?.();
    return true;
  },
};

const subscribers = new Set<() => void>();
function subscribeActive(callback: () => void) {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function selectActive(id: string | null) {
  activeCache = id;
  try {
    if (id === null) sessionStorage.removeItem(ACTIVE);
    else sessionStorage.setItem(ACTIVE, id);
  } catch {
    /* Keep the value in this window when browser storage is unavailable. */
  }
  for (const callback of subscribers) callback();
}

export function useActiveSidebarSpaceId(): string | null {
  return useSyncExternalStore(subscribeActive, readActiveSidebarSpaceId, () => null);
}

let returnsCache: Readonly<Record<string, ScopedThreadRef>> | undefined;
function readReturnRefs(): Readonly<Record<string, ScopedThreadRef>> {
  return returnsCache ?? Option.getOrElse(decodeReturns(readStorage(RETURNS)), () => ({}));
}

export function useSidebarSpaces() {
  const [spaces, setSpaces] = useLocalStorage(DEFINITIONS, EMPTY, Definitions);
  const id = useActiveSidebarSpaceId();
  return {
    spaces,
    active: spaces.find((space) => space.id === id) ?? null,
    select: selectActive,
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

export function SidebarSpacePicker({
  spaces,
  active,
  onSelect,
  onEdit,
}: {
  spaces: readonly SidebarSpace[];
  active: SidebarSpace | null;
  onSelect: (space: SidebarSpace | null) => void;
  onEdit: () => void;
}) {
  const t = useUiTranslation();
  const items = [
    { value: ALL, label: t("All projects") },
    ...spaces.map(({ id, name }) => ({ value: id, label: name })),
  ];
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1 px-2">
      <div className="min-w-0 flex-1">
        <Select
          items={items}
          value={active?.id ?? ALL}
          onValueChange={(value) => {
            if (value !== null) onSelect(spaces.find(({ id }) => id === value) ?? null);
          }}
        >
          <SelectTrigger aria-label={t("Switch Space")} size="compact" variant="ghost">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {items.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {active ? (
        <SidebarMenuButton size="icon" aria-label={t("Edit Space")} onClick={onEdit}>
          <PencilIcon />
        </SidebarMenuButton>
      ) : null}
    </div>
  );
}

export function SidebarSpaceFooter({
  spaces,
  active,
  onSelect,
  onCreate,
}: {
  spaces: readonly SidebarSpace[];
  active: SidebarSpace | null;
  onSelect: (space: SidebarSpace | null) => void;
  onCreate: () => void;
}) {
  const t = useUiTranslation();
  const rail = [
    { space: null, label: t("All projects") },
    ...spaces.slice(0, 2).map((space) => ({ space, label: space.name })),
  ];
  return (
    <div className="flex min-w-0 items-center justify-between gap-1">
      <div className="flex min-w-0 items-center gap-1">
        {rail.map(({ space, label }) => (
          <Tooltip key={space?.id ?? ALL}>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  size="icon"
                  aria-label={label}
                  aria-pressed={(space?.id ?? null) === (active?.id ?? null)}
                  isActive={(space?.id ?? null) === (active?.id ?? null)}
                  onClick={() => onSelect(space)}
                >
                  {space === null ? <FolderIcon /> : <span>{Array.from(space.name)[0]}</span>}
                </SidebarMenuButton>
              }
            />
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        ))}
        {spaces.length > 2 ? (
          <Menu>
            <MenuTrigger render={<SidebarMenuButton size="icon" aria-label={t("More Spaces")} />}>
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup side="top" align="start">
              {spaces.slice(2).map((space) => (
                <MenuItem key={space.id} onClick={() => onSelect(space)}>
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
            <SidebarMenuButton size="icon" aria-label={t("New Space")} onClick={onCreate}>
              <PlusIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{t("New Space")}</TooltipPopup>
      </Tooltip>
    </div>
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
  const [name, setName] = useState(editing?.name ?? "");
  const [selected, setSelected] = useState(
    () => new Map(editing?.projectRefs.map((ref) => [sidebarSpaceProjectKey(ref), ref])),
  );
  const nameKey = normalizeSidebarSpaceName(name);
  const duplicate = spaces.some(
    (space) => space.id !== editing?.id && normalizeSidebarSpaceName(space.name) === nameKey,
  );
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
            onSave({
              id: editing?.id ?? randomUUID(),
              name: name.trim(),
              projectRefs: [...selected.values()],
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? t("Edit Space") : t("New Space")}</DialogTitle>
            <DialogDescription>
              {t("Choose which projects to show in this Space.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-6 py-3">
            <label htmlFor={nameId}>{t("Space name")}</label>
            <Input
              id={nameId}
              maxLength={80}
              value={name}
              aria-invalid={duplicate}
              onChange={(event) => setName(event.target.value)}
            />
            {duplicate ? <p role="status">{t("A Space with this name already exists.")}</p> : null}
            <div className="flex max-h-56 flex-col gap-2 overflow-auto">
              {projects.map(({ ref, label }) => {
                const key = sidebarSpaceProjectKey(ref);
                return (
                  <label className="flex items-center gap-2" key={key}>
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
          <DialogFooter>
            {editing ? (
              <Button type="button" variant="destructive" onClick={() => onRemove(editing.id)}>
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
        <div className="flex max-h-60 flex-col items-start overflow-auto px-6">
          {projects.map(({ ref, label }) => (
            <Button key={sidebarSpaceProjectKey(ref)} variant="ghost" onClick={() => onSelect(ref)}>
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
