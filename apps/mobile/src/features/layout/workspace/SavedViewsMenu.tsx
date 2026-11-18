import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  type SavedViewIdentity as SavedViewIdentitySchema,
  savedViewNameError,
} from "@t3tools/client-runtime/saved-views";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert } from "react-native";

import { prompt as showTextInputDialog } from "../../../components/ui/Dialog";
import type { MenuProps } from "../../../components/ui/Menu.types";
import { uuidv4 } from "../../../lib/uuid";
import type { Preferences } from "../../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import { ListFilterMenu } from "./ListFilterMenu";

type SavedViewIdentity = typeof SavedViewIdentitySchema.Type;
const EMPTY_SAVED_VIEWS: ReadonlyArray<never> = [];

export function SavedViewsMenu<Scope extends object>({
  read,
  write,
  noun,
  shortNoun,
  suggestedName,
  scope,
  matches,
  onApply,
}: {
  read: (preferences: Preferences) => ReadonlyArray<Scope & SavedViewIdentity> | undefined;
  write: (views: ReadonlyArray<Scope & SavedViewIdentity>) => Partial<Preferences>;
  /** "pull request" in the menu's label, "PR" in its dialogs. */
  noun: string;
  shortNoun: string;
  suggestedName: string;
  scope: Scope;
  matches: (view: Scope, scope: Scope) => boolean;
  onApply: (view: Scope & SavedViewIdentity) => Promise<void> | void;
}) {
  const t = useUiTranslation();
  type View = Scope & SavedViewIdentity;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const views: ReadonlyArray<View> = AsyncResult.isSuccess(preferences)
    ? (read(preferences.value) ?? EMPTY_SAVED_VIEWS)
    : EMPTY_SAVED_VIEWS;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedView =
    views.find((view) => view.id === selectedId) ?? views.find((view) => matches(view, scope));
  if (selectedId === null && selectedView) setSelectedId(selectedView.id);
  const modified = selectedView !== undefined && !matches(selectedView, scope);

  // These avoid `finally`, which the React Compiler cannot lower; every path clears `busy`.
  async function applyView(view: View) {
    setBusy(true);
    try {
      await onApply(view);
      setSelectedId(view.id);
    } catch {
      Alert.alert(
        t("Could not apply {kind} view", { kind: t(shortNoun) }),
        t("The device could not save your filters. Try again."),
      );
    }
    setBusy(false);
  }

  async function persist(transform: (current: ReadonlyArray<View>) => ReadonlyArray<View>) {
    setBusy(true);
    let saved = true;
    try {
      await savePreferences({
        transform: (current) => write(transform(read(current) ?? EMPTY_SAVED_VIEWS)),
      });
    } catch {
      Alert.alert(
        t("Could not save {kind} views", { kind: t(shortNoun) }),
        t("The device could not save your views. Try again."),
      );
      saved = false;
    }
    setBusy(false);
    return saved;
  }

  function editName(view?: View) {
    showTextInputDialog({
      title: view
        ? t("Rename {kind} view", { kind: t(shortNoun) })
        : t("Save {kind} view", { kind: t(shortNoun) }),
      initialValue: view?.name ?? t(suggestedName),
      confirmText: t("Save"),
      onConfirm: (value) => {
        const error = savedViewNameError(value, views, view?.id);
        if (error) {
          Alert.alert(t("Could not save view"), t(error));
          return;
        }
        const id = view?.id ?? uuidv4();
        const name = value.trim();
        void persist((current) =>
          view
            ? current.map((item) => (item.id === view.id ? { ...item, name } : item))
            : [...current, { ...scope, id, name }],
        ).then((saved) => {
          if (saved) setSelectedId(id);
        });
      },
    });
  }

  const actions: MenuProps["actions"] = [
    ...views.map((view) => ({
      id: `apply:${view.id}`,
      title: view.name,
      state: selectedView?.id === view.id && !modified ? ("on" as const) : ("off" as const),
    })),
    { id: "save", title: t("Save current view…") },
    ...(selectedView
      ? [
          ...(modified ? [{ id: "update", title: t("Update saved view") }] : []),
          { id: "rename", title: t("Rename view…") },
          { id: "delete", title: t("Delete view"), attributes: { destructive: true } },
        ]
      : []),
  ];

  return (
    <ListFilterMenu
      label={selectedView ? `${selectedView.name}${modified ? " *" : ""}` : t("Views")}
      active={selectedView !== undefined}
      accessibilityLabel={t("Saved {kind} views", { kind: t(noun) })}
      actions={actions.map((action) => ({
        ...action,
        attributes: { ...action.attributes, disabled: !ready || busy },
      }))}
      onSelect={(id) => {
        if (!ready || busy) return;
        const view = views.find((item) => `apply:${item.id}` === id);
        if (view) {
          void applyView(view);
          return;
        }
        if (id === "save") editName();
        else if (id === "rename" && selectedView) editName(selectedView);
        else if (id === "update" && selectedView)
          void persist((current) =>
            current.map((item) => (item.id === selectedView.id ? { ...item, ...scope } : item)),
          );
        else if (id === "delete" && selectedView)
          void persist((current) => current.filter((item) => item.id !== selectedView.id)).then(
            (saved) => {
              if (saved) setSelectedId(null);
            },
          );
      }}
    />
  );
}
