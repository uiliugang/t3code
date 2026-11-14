import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  Issue,
  IssueProvider,
  IssueMetadataInput,
  ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogFooter,
  DialogHeader,
  DialogPanel,
} from "../ui/dialog";
import { IssueSelect } from "./IssueSelect";
import { Checkbox } from "../ui/checkbox";
import { SearchIcon } from "lucide-react";
import { DraftFillButton } from "./DraftFillButton";

export function IssueCreateDialog({
  environmentId,
  provider: initialProvider,
  projects,
  initialProjectId,
  close,
  created,
}: {
  environmentId: EnvironmentId;
  provider: IssueProvider;
  projects: ReadonlyArray<{ id: ProjectId; title: string }>;
  initialProjectId?: ProjectId;
  close: () => void;
  created: (issue: Issue, projectId: ProjectId) => void;
}) {
  const t = useUiTranslation();
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id);
  const [selectedScope, setSelectedScope] = useState("");
  const sourceQuery = useEnvironmentQuery(
    projectId
      ? sourceControlEnvironment.issueSources({ environmentId, input: { projectIds: [projectId] } })
      : null,
  );
  const [selectedProvider, setProvider] = useState<IssueProvider | null>(null);
  const availableProviders = [
    ...new Set(sourceQuery.data?.[0]?.sources.map((source) => source.provider) ?? []),
  ];
  const platformSelected =
    availableProviders.length === 1 ||
    (selectedProvider !== null && availableProviders.includes(selectedProvider));
  const provider =
    availableProviders.length === 1
      ? availableProviders[0]!
      : (selectedProvider ?? initialProvider);
  const scopes =
    sourceQuery.data?.[0]?.sources
      .filter((source) => source.provider === provider)
      .map((source) => source.scope) ?? [];
  const scope = scopes.includes(selectedScope) ? selectedScope : scopes[0];
  const [type, setType] = useState<(typeof IssueMetadataInput.Type)["type"]>("REQUIREMENT");
  const [subtype, setSubtype] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [personSearch, setPersonSearch] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    ReadonlyArray<{ variable: string; message: string }>
  >([]);
  const [uncertain, setUncertain] = useState(false);
  const canCreate = useAtomValue(
    sourceControlEnvironment.createIssue.permissionAtom(environmentId),
  );
  const command = useAtomCommand(sourceControlEnvironment.createIssue, { reportFailure: false });
  const metadata = useEnvironmentQuery(
    projectId && scope && platformSelected
      ? sourceControlEnvironment.issueMetadata({
          environmentId,
          input: { projectId, provider, type, subtype, query: personQuery, scope },
        })
      : null,
  );
  const people = useEnvironmentQuery(
    projectId && scope && platformSelected
      ? sourceControlEnvironment.issuePeople({
          environmentId,
          input: { projectId, provider, query: personQuery, scope },
        })
      : null,
  );
  const submit = async () => {
    if (!projectId || !scope || !title.trim() || generating || !platformSelected) return;
    setBusy(true);
    setError(null);
    setFieldErrors([]);
    const result = await command({
      environmentId,
      input: {
        projectId,
        scope,
        provider,
        type,
        subtype,
        title,
        body,
        assignees: assignee ? [assignee] : [],
        fields,
      },
    });
    setBusy(false);
    if (result._tag === "Success") created(result.value, projectId);
    else {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? t(failure.message) : t("Could not create issue."));
      if (
        failure &&
        typeof failure === "object" &&
        "_tag" in failure &&
        failure._tag === "IssueError" &&
        "fields" in failure &&
        Array.isArray(failure.fields)
      )
        setFieldErrors(failure.fields);
      if (
        failure &&
        typeof failure === "object" &&
        "reason" in failure &&
        failure.reason === "outcome-unknown"
      )
        setUncertain(true);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !generating) close();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="flex max-h-[calc(100dvh-6rem)] min-h-0 flex-col"
        >
          <DialogHeader>
            <DialogTitle>{t("New issue")}</DialogTitle>
            <div className="text-xs text-muted-foreground">
              {provider === "meituan" ? "MEP ONES" : "GitHub Issues"}
            </div>
          </DialogHeader>
          <DialogPanel>
            <div className="flex justify-end">
              <DraftFillButton
                environmentId={environmentId}
                projectId={projectId}
                disabled={busy || uncertain}
                context={[title, body].filter(Boolean).join("\n\n")}
                onBusyChange={setGenerating}
                onDraft={(draft) => {
                  setTitle(draft.title);
                  setBody(
                    [
                      draft.description,
                      draft.constraints.length
                        ? t("Constraints") +
                          "\n" +
                          draft.constraints.map((line) => "- " + line).join("\n")
                        : "",
                      draft.acceptanceCriteria.length
                        ? t("Acceptance criteria") +
                          "\n" +
                          draft.acceptanceCriteria.map((line) => "- " + line).join("\n")
                        : "",
                    ]
                      .filter(Boolean)
                      .join("\n\n"),
                  );
                }}
              />
            </div>
            <fieldset disabled={generating} className="contents">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t("Project")}</Label>
                  <IssueSelect
                    label={t("Project")}
                    value={projectId ?? ""}
                    options={projects.map((project) => ({
                      value: project.id,
                      label: project.title,
                    }))}
                    onChange={(value) => {
                      setProjectId(value as ProjectId);
                      setProvider(null);
                      setSelectedScope("");
                      setAssignee("");
                      setPersonSearch("");
                      setPersonQuery("");
                      setSubtype("");
                      setFields({});
                    }}
                    disabled={busy}
                  />
                </div>
                {availableProviders.length > 1 ? (
                  <div className="space-y-1.5">
                    <Label>{t("Issue source")}</Label>
                    <IssueSelect
                      label={t("Issue source")}
                      value={selectedProvider ?? ""}
                      options={[
                        { value: "", label: t("Choose platform") },
                        ...availableProviders.map((value) => ({
                          value,
                          label: value === "github" ? "GitHub Issues" : "MEP ONES",
                        })),
                      ]}
                      onChange={(value) => {
                        setProvider(value === "github" || value === "meituan" ? value : null);
                        setAssignee("");
                        setPersonSearch("");
                        setPersonQuery("");
                        setSelectedScope("");
                        setSubtype("");
                        setFields({});
                      }}
                      disabled={busy || generating}
                    />
                  </div>
                ) : null}
                {scopes.length > 1 ? (
                  <div className="space-y-1.5">
                    <Label>{t("MEP space ID")}</Label>
                    <IssueSelect
                      label={t("MEP space ID")}
                      value={scope ?? ""}
                      options={scopes.map((value) => ({ value, label: value }))}
                      onChange={(value) => {
                        setSelectedScope(value);
                        setAssignee("");
                        setPersonSearch("");
                        setPersonQuery("");
                        setSubtype("");
                        setFields({});
                      }}
                      disabled={busy}
                    />
                  </div>
                ) : null}
                {provider === "meituan" ? (
                  <div className="space-y-1.5">
                    <Label>{t("Work item type")}</Label>
                    <IssueSelect
                      label={t("Work item type")}
                      value={type}
                      options={[
                        { value: "REQUIREMENT", label: t("Requirement") },
                        { value: "DEVTASK", label: t("Task") },
                        { value: "DEFECT", label: t("Defect") },
                      ]}
                      onChange={(value) => {
                        setType(value as typeof type);
                        setSubtype("");
                        setFields({});
                      }}
                      disabled={busy}
                    />
                  </div>
                ) : null}
              </div>
              {provider === "meituan" ? (
                <IssueSelect
                  label={t("Subtype")}
                  value={subtype}
                  options={[
                    { value: "", label: t("Select subtype") },
                    ...(metadata.data?.subtypes ?? []),
                  ]}
                  onChange={(value) => {
                    setSubtype(value);
                    setFields({});
                  }}
                  disabled={busy}
                />
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="issue-title">{t("Title")} *</Label>
                <Input
                  id="issue-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={256}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="issue-body">{t("Description")}</Label>
                <Textarea
                  id="issue-body"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={5}
                  disabled={busy}
                />
              </div>
              <div className="flex items-center gap-2">
                <Input
                  aria-label={t("Search people")}
                  placeholder={t("Search people")}
                  value={personSearch}
                  onChange={(event) => setPersonSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      setPersonQuery(personSearch);
                    }
                  }}
                  disabled={busy}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label={t("Search people")}
                  onClick={() => setPersonQuery(personSearch)}
                  disabled={busy}
                >
                  <SearchIcon />
                </Button>
              </div>
              {!metadata.data?.fields.some((field) => field.variable === "assigned") ? (
                <IssueSelect
                  label={t("Assignee")}
                  value={assignee}
                  options={[{ value: "", label: t("Unassigned") }, ...(people.data ?? [])]}
                  onChange={setAssignee}
                  disabled={busy}
                />
              ) : null}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {metadata.data?.fields.map((field) => (
                  <div key={field.variable} className="space-y-1.5">
                    <Label htmlFor={`issue-field-${field.variable}`}>
                      {field.label}
                      {field.required ? " *" : ""}
                    </Label>
                    {field.options.length ? (
                      field.multiple ? (
                        <div className="max-h-36 space-y-2 overflow-auto">
                          {field.options.map((option) => (
                            <label key={option.value} className="flex items-center gap-2 text-sm">
                              <Checkbox
                                disabled={busy}
                                checked={(fields[field.variable] ?? "")
                                  .split(",")
                                  .includes(option.value)}
                                onCheckedChange={(checked) => {
                                  const selected = (fields[field.variable] ?? "")
                                    .split(",")
                                    .filter(Boolean)
                                    .filter((value) => value !== option.value);
                                  setFields({
                                    ...fields,
                                    [field.variable]: [
                                      ...selected,
                                      ...(checked ? [option.value] : []),
                                    ].join(","),
                                  });
                                }}
                              />
                              {option.label}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <IssueSelect
                          label={field.label}
                          value={fields[field.variable] ?? ""}
                          options={[{ value: "", label: t("Select...") }, ...field.options]}
                          onChange={(value) => setFields({ ...fields, [field.variable]: value })}
                          disabled={busy}
                        />
                      )
                    ) : (
                      <Input
                        id={`issue-field-${field.variable}`}
                        value={fields[field.variable] ?? ""}
                        onChange={(event) =>
                          setFields({ ...fields, [field.variable]: event.target.value })
                        }
                        type={field.type === "date" ? "date" : "text"}
                        required={field.required}
                        placeholder={field.type === "person" ? t("MIS ID") : undefined}
                        disabled={busy}
                      />
                    )}
                  </div>
                ))}
              </div>
              {metadata.error || error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error ?? metadata.error}
                </p>
              ) : null}
              {fieldErrors.length ? (
                <ul className="text-sm text-destructive">
                  {fieldErrors.map((field) => (
                    <li key={field.variable}>{field.message}</li>
                  ))}
                </ul>
              ) : null}
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={busy || generating}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                !canCreate ||
                generating ||
                !platformSelected ||
                busy ||
                uncertain ||
                !title.trim() ||
                !projectId ||
                !scope ||
                metadata.isPending ||
                Boolean(metadata.error) ||
                metadata.data?.fields.some(
                  (field) => field.required && !fields[field.variable]?.trim(),
                ) ||
                (provider === "meituan" && !subtype)
              }
            >
              {t(busy ? "Creating..." : "Create issue")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
