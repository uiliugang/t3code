import { useAtomValue, useAtomSet } from "@effect/atom-react";
import {
  type EnvironmentId,
  PROJECT_FOLDER_BATCH_LIMIT,
  type ProjectFolderCandidate,
  type ProjectFolderImportResult,
} from "@t3tools/contracts";
import {
  getAddProjectInitialQuery,
  selectProjectFolders,
  projectFolderStatus,
  type ProjectFolderSelection,
  type ProjectFolderImportLocation,
} from "@t3tools/client-runtime/operations/projects";
import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import {
  ArrowUpIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  CornerDownRightIcon,
} from "lucide-react";
import { useState } from "react";
import { projectFolderImportAtom, type ProjectFolderImportRequest } from "../projectFolderImport";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiTranslation } from "../hooks/useUiTranslation";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

export function ProjectFolderImportDialog() {
  const request = useAtomValue(projectFolderImportAtom);
  const setRequest = useAtomSet(projectFolderImportAtom);
  return request ? (
    <ProjectFolderImportSession initial={request} onClose={() => setRequest(null)} />
  ) : null;
}

function ProjectFolderImportSession({
  initial,
  onClose,
}: {
  initial: ProjectFolderImportRequest;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const available = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const [location, setLocation] = useState({
    environmentId:
      initial.environmentId ??
      initial.locations?.[0]?.environmentId ??
      available.find((entry) => entry.environmentId === primaryEnvironmentId)?.environmentId ??
      available[0]?.environmentId ??
      null,
    parentPath: initial.parentPath,
  });
  const target = location.environmentId;
  const [busy, setBusy] = useState(false);
  const environment = environments.find((entry) => entry.environmentId === target);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("Import folders")}</DialogTitle>
          <DialogDescription className="sr-only">
            {initial.projectTitle ?? t("Select folders to import.")}
          </DialogDescription>
        </DialogHeader>
        {target ? (
          <ProjectFolderPicker
            key={target}
            environmentId={target}
            initialPath={location.parentPath}
            locations={initial.locations ?? []}
            onLocationChange={setLocation}
            baseDirectory={environment?.serverConfig?.settings.addProjectBaseDirectory}
            connected={environment?.connection.phase === "connected"}
            onBusyChange={setBusy}
            onClose={onClose}
          />
        ) : (
          <p className="px-6 pb-6 text-sm text-muted-foreground">{t("Select environment")}</p>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ProjectFolderPicker({
  environmentId,
  initialPath,
  locations,
  onLocationChange,
  baseDirectory,
  connected,
  onBusyChange,
  onClose,
}: {
  environmentId: EnvironmentId;
  initialPath?: string | undefined;
  locations: ReadonlyArray<ProjectFolderImportLocation>;
  onLocationChange: (location: ProjectFolderImportLocation) => void;
  baseDirectory?: string | undefined;
  connected: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const t = useUiTranslation();
  const { environments } = useEnvironments();
  const [directory, setDirectory] = useState(
    initialPath ?? getAddProjectInitialQuery(baseDirectory),
  );
  const [pathInput, setPathInput] = useState(directory);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlyArray<ProjectFolderSelection>>([]);
  const [results, setResults] = useState<ReadonlyArray<ProjectFolderImportResult>>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const canImport = useAtomValue(projectEnvironment.importFolders.permissionAtom(environmentId));
  const browse = useEnvironmentQuery(
    connected && canImport
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: ensureBrowseDirectoryPath(directory) },
        })
      : null,
  );
  const entries = (browse.data?.entries ?? []).filter(
    (entry) =>
      entry.name.toLowerCase().includes(filter.toLowerCase()) &&
      (!entry.name.startsWith(".") || filter.startsWith(".")),
  );
  const paths = entries
    .slice(page * PROJECT_FOLDER_BATCH_LIMIT, (page + 1) * PROJECT_FOLDER_BATCH_LIMIT)
    .map((entry) => entry.fullPath);
  const inspect = useEnvironmentQuery(
    connected && canImport && paths.length > 0
      ? projectEnvironment.inspectFolders({ environmentId, input: { paths } })
      : null,
  );
  const candidates = inspect.data ?? [];
  const importFolders = useAtomCommand(projectEnvironment.importFolders, { reportFailure: false });
  const currentPath = browse.data?.parentPath ?? directory;
  const parent = getBrowseParentPath(ensureBrowseDirectoryPath(currentPath));
  const loading = browse.isPending || inspect.isPending;
  const availableCandidates = candidates.filter(
    (candidate) =>
      !results.some(
        (result) =>
          result.path === candidate.path &&
          (result.status === "created" || result.status === "existing"),
      ),
  );
  const bulkSelection = selectProjectFolders(selected, availableCandidates);
  const pageRoots = new Set(candidates.map((candidate) => candidate.workspaceRoot));
  const hasSelectedOnPage = selected.some((entry) => pageRoots.has(entry.workspaceRoot));
  const allAvailableSelected = hasSelectedOnPage && bulkSelection.length === selected.length;
  const navigate = (next: string) => {
    setDirectory(next);
    setPathInput(next);
    setFilter("");
    setPage(0);
  };
  const jumpToLocation = (next: ProjectFolderImportLocation) => {
    if (next.environmentId === environmentId) navigate(next.parentPath);
    else onLocationChange(next);
  };
  const toggle = (candidate: ProjectFolderCandidate, checked: boolean) =>
    setSelected((previous) =>
      checked
        ? selectProjectFolders(previous, [candidate], true)
        : previous.filter((entry) => entry.workspaceRoot !== candidate.workspaceRoot),
    );
  const submit = async () => {
    if (busy || selected.length === 0 || !connected || !canImport) return;
    setBusy(true);
    onBusyChange(true);
    setFailure(null);
    const completed: ProjectFolderImportResult[] = [];
    for (let offset = 0; offset < selected.length; offset += PROJECT_FOLDER_BATCH_LIMIT) {
      const response = await importFolders({
        environmentId,
        input: {
          folders: selected
            .slice(offset, offset + PROJECT_FOLDER_BATCH_LIMIT)
            .map((entry) => ({ path: entry.path, allowSameRepository: entry.allowSameRepository })),
        },
      });
      if (response._tag === "Failure") {
        setFailure(t("Import interrupted. Retry remaining folders."));
        break;
      }
      completed.push(...response.value);
    }
    setResults(completed);
    const done = new Set(
      completed.filter((entry) => entry.status !== "failed").map((entry) => entry.path),
    );
    setSelected((previous) => previous.filter((entry) => !done.has(entry.path)));
    inspect.refresh();
    setBusy(false);
    onBusyChange(false);
  };
  return (
    <>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-6 pb-4">
        <form
          className="flex min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (pathInput.trim()) navigate(pathInput.trim());
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              aria-label={t("Folder path")}
              value={pathInput}
              disabled={busy}
              onChange={(event) => setPathInput(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            type="button"
            title={t("Parent folder")}
            aria-label={t("Parent folder")}
            disabled={!parent || busy}
            onClick={() => {
              if (parent) navigate(parent);
            }}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="outline"
            size="icon"
            type="submit"
            title={t("Open folder")}
            aria-label={t("Open folder")}
            disabled={busy || !pathInput.trim()}
          >
            <ArrowRightIcon />
          </Button>

          {locations.length === 1 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={
                      busy ||
                      !environments.some(
                        (entry) =>
                          entry.environmentId === locations[0]!.environmentId &&
                          entry.connection.phase === "connected",
                      )
                    }
                    onClick={() => jumpToLocation(locations[0]!)}
                  />
                }
              >
                <CornerDownRightIcon />
                {t("Sibling folders")}
              </TooltipTrigger>
              <TooltipPopup>{locations[0]!.parentPath}</TooltipPopup>
            </Tooltip>
          ) : locations.length > 1 ? (
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={<Button variant="secondary" type="button" disabled={busy} />}
                    />
                  }
                >
                  <CornerDownRightIcon />
                  {t("Sibling folders")}
                  <ChevronDownIcon />
                </TooltipTrigger>
                <TooltipPopup>
                  {locations.map((entry) => (
                    <div key={`${entry.environmentId}:${entry.parentPath}`}>{entry.parentPath}</div>
                  ))}
                </TooltipPopup>
              </Tooltip>
              <MenuPopup align="end">
                {locations.map((entry) => {
                  const source = environments.find(
                    (candidate) => candidate.environmentId === entry.environmentId,
                  );
                  return (
                    <MenuItem
                      key={`${entry.environmentId}:${entry.parentPath}`}
                      disabled={source?.connection.phase !== "connected"}
                      onClick={() => jumpToLocation(entry)}
                    >
                      <div className="flex min-w-0 flex-col">
                        <span>{entry.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {source?.label ?? entry.environmentId} · {entry.parentPath}
                        </span>
                      </div>
                    </MenuItem>
                  );
                })}
              </MenuPopup>
            </Menu>
          ) : null}
        </form>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-44 max-w-full">
            <Input
              size="sm"
              aria-label={t("Filter folders")}
              placeholder={t("Filter folders")}
              value={filter}
              disabled={busy}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(0);
              }}
            />
          </div>

          <label className="flex items-center gap-2 whitespace-nowrap text-sm">
            <Checkbox
              checked={allAvailableSelected}
              indeterminate={hasSelectedOnPage && !allAvailableSelected}
              disabled={
                busy || loading || (!hasSelectedOnPage && bulkSelection.length === selected.length)
              }
              onCheckedChange={(checked) =>
                setSelected((previous) =>
                  checked
                    ? selectProjectFolders(previous, availableCandidates)
                    : previous.filter((entry) => !pageRoots.has(entry.workspaceRoot)),
                )
              }
            />
            {t("Select available")}
          </label>
        </div>
        {!connected || !canImport ? (
          <p role="alert">{t("This connection cannot import folders.")}</p>
        ) : null}
        {failure || browse.error || inspect.error ? (
          <p role="alert" className="text-sm text-destructive">
            {failure ?? browse.error ?? inspect.error}
          </p>
        ) : null}
        <div className="h-72 shrink-0 overflow-y-auto rounded-md border" aria-busy={loading}>
          {loading ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              {t("Checking folders...")}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("No folders found")}</p>
          ) : (
            candidates.map((candidate) => {
              const result = results.find((entry) => entry.path === candidate.path);
              const added =
                candidate.existingProjectId ||
                result?.status === "created" ||
                result?.status === "existing";
              return (
                <div
                  key={candidate.path}
                  className="flex min-h-12 items-center gap-3 border-b px-3 py-2 last:border-0 has-[[data-slot=checkbox][data-checked]]:bg-primary/5"
                >
                  <Checkbox
                    aria-label={`${t("Select folder")} ${candidate.title}`}
                    disabled={busy || Boolean(added) || Boolean(candidate.error)}
                    checked={selected.some(
                      (entry) => entry.workspaceRoot === candidate.workspaceRoot,
                    )}
                    onCheckedChange={(checked) => toggle(candidate, checked)}
                  />
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <Tooltip>
                      <TooltipTrigger render={<p className="truncate text-sm" />}>
                        {candidate.title}
                      </TooltipTrigger>
                      <TooltipPopup>{candidate.path}</TooltipPopup>
                    </Tooltip>
                  </div>
                  <Tooltip>
                    <TooltipTrigger
                      render={<p className="max-w-40 truncate text-xs text-muted-foreground" />}
                    >
                      {added
                        ? t("Already added")
                        : candidate.error || candidate.matchingRepositoryProjectId
                          ? t(projectFolderStatus(candidate))
                          : t(candidate.repositoryKey ? "Git repository" : "Folder")}
                    </TooltipTrigger>
                    <TooltipPopup>
                      {added ? t("Already added") : t(projectFolderStatus(candidate))}
                    </TooltipPopup>
                  </Tooltip>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title={`${t("Open folder")} ${candidate.title}`}
                    aria-label={`${t("Open folder")} ${candidate.title}`}
                    disabled={busy}
                    onClick={() => navigate(candidate.path)}
                  >
                    <ChevronRightIcon />
                  </Button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{currentPath}</span>
          <span className="shrink-0">{t("{count} folders", { count: entries.length })}</span>
        </div>
        {entries.length > PROJECT_FOLDER_BATCH_LIMIT ? (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Previous page")}
              disabled={page === 0 || busy}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <span>
              {page + 1} / {Math.ceil(entries.length / PROJECT_FOLDER_BATCH_LIMIT)}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Next page")}
              disabled={(page + 1) * PROJECT_FOLDER_BATCH_LIMIT >= entries.length || busy}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        ) : null}
        {results.length > 0 ? (
          <div role="status" className="text-sm">
            {t("Imported")}: {results.filter((entry) => entry.status === "created").length},{" "}
            {t("Skipped")}:{" "}
            {
              results.filter(
                (entry) => entry.status === "existing" || entry.status === "repository",
              ).length
            }
            , {t("Failed")}: {results.filter((entry) => entry.status === "failed").length}
            {results
              .filter((entry) => entry.status === "failed")
              .map((entry) => (
                <p key={entry.path} className="break-all text-xs text-destructive">
                  {entry.path}: {entry.error}
                </p>
              ))}
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <p className="mr-auto text-xs text-muted-foreground">
          {t("Each folder is imported as a project.")}
        </p>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          {t(results.length > 0 ? "Done" : "Cancel")}
        </Button>
        <Button
          disabled={busy || !canImport || !connected || selected.length === 0}
          onClick={() => void submit()}
        >
          <FolderPlusIcon />
          {t(
            busy
              ? "Importing..."
              : results.some((entry) => entry.status === "failed") || failure
                ? "Retry remaining"
                : "Import projects",
          )}{" "}
          ({selected.length})
        </Button>
      </DialogFooter>
    </>
  );
}
