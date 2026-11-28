import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  isReasoningControl,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import { msg, useGT, useMessages } from "gt-react";
import { ChevronRightIcon, ChevronUpIcon, WorkflowIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, use, useRef, useState } from "react";

import { useUiTranslation } from "../../hooks/useUiTranslation";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Switch } from "../ui/switch";
import type { ComposerControlSize } from "./ComposerControl";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { composerFloatingLayerProps, focusCheckedPermission } from "./composerEventScope";
import { EffortGlyph, FastBolt, resolveEffortGlyph } from "./EffortGlyph";
import { DockedPickerContext } from "./ProviderModelPicker";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
  ULTRATHINK_IN_BODY_NOTE,
  useTraitsSelection,
} from "./TraitsPicker";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Service tiers, Claude's Fast mode, and Ultracode sit in the footer, not the column. */
function splitSpeed(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect = selects.find((descriptor) => descriptor.id === "serviceTier") ?? null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
  };
}

type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning levels under the header that names it. Other options,
 * such as an agent's session mode, sit below as one row each.
 */
function columnControls(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort = controls.find((control) => isReasoningControl(control.descriptor)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/**
 * What the model trigger shows after the model name: the effort word (or bars, per the
 * Appearance setting), a bolt for Fast, a workflow icon for Ultracode, and other traits such as a
 * context window.
 */
export function describeComposerEffort(
  traits: TraitsSelectionInput | null,
  effortDisplay: EffortDisplay,
  size: ComposerControlSize,
  resolve: MessageResolver = m,
): { suffix: ReactNode; detail: string | null } {
  if (!traits) return { suffix: null, detail: null };
  const visibility = getTraitsSectionVisibility({ ...traits, resolve });
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const modelSelection =
    traits.instanceId && traits.model
      ? { instanceId: traits.instanceId, model: traits.model, options: traits.modelOptions ?? [] }
      : null;
  const primary = visibility.primarySelectDescriptor;
  const display = buildTraitsTriggerDisplay(
    {
      descriptors: visibility.descriptors,
      primarySelectDescriptorId: primary?.id ?? null,
      ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
      modelSelection,
      reportedModelSelection: traits.reportedModelSelection,
    },
    resolve,
  );
  // The same reasoning control the column lists, wherever the agent put it among its options.
  const reasoning =
    columnControls(visibility.selectDescriptors, visibility.booleanDescriptors).effort
      ?.descriptor ?? null;
  const ultrathink = visibility.ultrathinkPromptControlled && reasoning === primary;
  const glyph =
    reasoning?.type === "select"
      ? resolveEffortGlyph(
          reasoning,
          ultrathink
            ? "ultrathink"
            : getDescriptorStringValue(reasoning, modelSelection, traits.reportedModelSelection),
        )
      : null;
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const word = glyph
    ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
    : !reasoning
      ? null
      : reasoning.type === "boolean"
        ? reasoning.currentValue === true
          ? resolve(msg("{option} On", { option: reasoning.label }))
          : resolve(msg("{option} Off", { option: reasoning.label }))
        : ultrathink
          ? "Ultrathink"
          : (getProviderOptionCurrentLabel(
              reasoning,
              modelSelection,
              traits.reportedModelSelection,
            ) ?? (reasoning.id === "thinking" ? reasoning.label : null));
  const fast = display.speedLabel === "Fast" || display.speedLabel === "Ultrafast";
  // Agent options such as modes live in the picker; the trigger adds only the context window.
  const contextWindow =
    visibility.contextWindowDescriptor &&
    getProviderOptionCurrentLabel(
      visibility.contextWindowDescriptor,
      modelSelection,
      traits.reportedModelSelection,
    );
  if (!word && !glyph && !fast && !display.ultracode && !contextWindow)
    return { suffix: null, detail: display.label };
  return {
    detail: display.label,
    suffix: (
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-muted-foreground group-hover/model-trigger:text-foreground group-data-pressed/model-trigger:text-foreground group-data-popup-open/model-trigger:text-foreground",
          // A word space after the model name: the regular trigger's gap is wider than one.
          size === "sm" && "-ms-0.5",
        )}
      >
        {word ? (
          <span data-composer-control-label className="max-w-24 truncate">
            {word}
          </span>
        ) : glyph ? (
          <EffortGlyph count={glyph.count} filled={glyph.filled} size={size} />
        ) : null}
        {fast ? <FastBolt ultra={display.speedLabel === "Ultrafast"} /> : null}
        {display.ultracode ? (
          <WorkflowIcon aria-hidden="true" data-composer-control-icon className="size-3" />
        ) : null}
        {contextWindow ? (
          <span
            // A label, so icon-only footers drop it; compacted rows drop it before the model.
            data-composer-control-label
            data-composer-secondary-trait
            className="max-w-24 truncate text-xs"
          >
            {contextWindow}
          </span>
        ) : null}
      </span>
    ),
  };
}

const COLUMN_ROW =
  "flex h-9 w-full shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";

/** The levels share one line, so Up and Down step over the group instead of through it. */
function rowOnAdjacentLine(
  rows: ReadonlyArray<HTMLButtonElement>,
  index: number,
  direction: 1 | -1,
): HTMLButtonElement | undefined {
  const groupOf = (row: HTMLButtonElement) => row.closest('[role="radiogroup"]');
  const group = groupOf(rows[index]!);
  for (let i = index + direction; i >= 0 && i < rows.length; i += direction) {
    const row = rows[i]!;
    if (group && groupOf(row) === group) continue;
    const targetGroup = groupOf(row);
    // Up from an option lands on the level that holds the tab stop.
    return (
      (direction === -1 && targetGroup
        ? [...rows].filter((candidate) => groupOf(candidate) === targetGroup)
        : [row]
      ).find((candidate) => candidate.tabIndex === 0) ?? row
    );
  }
  return undefined;
}

function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
  if (
    !arrow &&
    (event.key.length !== 1 ||
      event.key.trim() === "" ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.nativeEvent.isComposing)
  )
    return;
  // An option's side menu is a React child here, but it moves through its own items.
  if (!event.currentTarget.contains(event.target as Node)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-effort-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const next = arrow
    ? index === -1
      ? rows[Math.min(rows.length - 1, Math.max(0, index + direction))]
      : rowOnAdjacentLine(rows, index, direction)
    : [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find((row) =>
        row.dataset.effortLevel?.toLowerCase().startsWith(event.key.toLowerCase()),
      );
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

const LEVEL_SEGMENT =
  "flex cursor-pointer flex-col rounded-md px-0.5 pt-2.5 pb-1 outline-none hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

type EffortChoice = {
  id: string;
  label: string;
  description?: string | undefined;
  isDefault?: boolean | undefined;
};

/**
 * The reasoning levels as one bar: it fills up to the chosen level, and each level names itself
 * under its segment. Press or drag the bar to pick; Left and Right move between levels.
 */
function EffortBar(props: { control: ColumnControl; traits: TraitsSelection; locked: boolean }) {
  const t = useUiTranslation();
  const messages = useMessages();
  const groupRef = useRef<HTMLDivElement>(null);
  const { control, traits, locked } = props;
  const { descriptor } = control;
  const choices: ReadonlyArray<EffortChoice> =
    control.kind === "boolean"
      ? [
          { id: "off", label: t("Off") },
          { id: "on", label: t("On") },
        ]
      : selectableProviderOptionChoices(control.descriptor);
  const value =
    control.kind === "boolean"
      ? control.descriptor.currentValue === true
        ? "on"
        : "off"
      : traits.selectValue(control.descriptor);
  // An "Ultrathink:" prefix selects a level the bar does not offer.
  const selectedIndex = choices.findIndex((choice) => choice.id === value);
  const pick = (id: string) => {
    if (control.kind === "boolean") traits.changeBoolean(descriptor.id, id === "on");
    else traits.changeSelect(control.descriptor, id);
  };
  const pickAt = (clientX: number) => {
    const box = groupRef.current?.getBoundingClientRect();
    if (!box?.width) return;
    const index = Math.min(
      choices.length - 1,
      Math.max(0, Math.floor(((clientX - box.left) / box.width) * choices.length)),
    );
    pick(choices[index]!.id);
  };
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={descriptor.label}
      className="mx-1.5 mt-1 grid touch-pan-y select-none gap-1"
      style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}
      onPointerDown={(event) => {
        if (locked) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pickAt(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) pickAt(event.clientX);
      }}
      onKeyDown={(event) => {
        if (locked || event.altKey || event.ctrlKey || event.metaKey) return;
        const levels = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "[data-effort-level]:not(:disabled)",
          ),
        );
        const index = levels.findIndex((level) => level === document.activeElement);
        if (index === -1) return;
        // Left off the first level falls through to the picker, which returns to its search.
        const target = {
          ArrowLeft: index > 0 ? index - 1 : undefined,
          ArrowRight: index < levels.length - 1 ? index + 1 : undefined,
          Home: 0,
          End: levels.length - 1,
        }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        levels[target]?.focus();
      }}
    >
      {locked ? (
        <p className={cn("col-span-full text-muted-foreground/80 text-xs")} role="presentation">
          {messages(ULTRATHINK_IN_BODY_NOTE)}
        </p>
      ) : null}
      {choices.map((choice, index) => {
        const selected = choice.id === value;
        const filled = selectedIndex >= 0 && index <= selectedIndex;
        const hint = choice.description ?? (choice.isDefault ? t("Default") : null);
        const content = (
          <>
            <span
              aria-hidden="true"
              className={cn(
                "block h-1.5 rounded-full bg-foreground/12 transition-colors",
                filled && "bg-primary",
              )}
            />
            <span
              className={cn(
                "mt-2 block truncate text-center text-muted-foreground text-xs leading-4",
                selected && "font-semibold text-foreground",
              )}
            >
              {choice.label}
            </span>
            {selected && choice.isDefault ? <span className="sr-only">{t("Default")}</span> : null}
          </>
        );
        const button = (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={locked}
            data-effort-row
            data-effort-level={choice.label}
            // Up and Down move between rows.
            tabIndex={(selectedIndex >= 0 ? selected : index === 0) ? 0 : -1}
            className={LEVEL_SEGMENT}
            // A press picks on pointerdown; this click is the keyboard's.
            onClick={(event) => {
              if (event.detail === 0) pick(choice.id);
            }}
          >
            {content}
          </button>
        );
        return hint ? (
          <SharedTooltipTrigger
            key={choice.id}
            render={button}
            label={hint}
            side="top"
            className="max-w-56"
          />
        ) : (
          button
        );
      })}
    </div>
  );
}

function EffortLevels(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { effort, others } = columnControls(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable) {
    return (
      <>
        {traits.descriptors.map((descriptor) => {
          const value = traits.currentLabel(descriptor);
          return value ? (
            <div key={descriptor.id} className="flex h-9 items-center gap-2 px-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {descriptor.label}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">{value}</span>
            </div>
          ) : null;
        })}
      </>
    );
  }
  if (!effort && others.length === 0) return <NoEffortRow />;
  // Ultrathink in the prompt locks the levels; the first option then holds the tab stop.
  const locked =
    effort?.descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
  return (
    <>
      {effort ? <EffortBar control={effort} traits={traits} locked={locked} /> : null}
      {others.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {others.map((control, index) =>
            control.kind === "boolean" ? (
              <OptionSwitchRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ) : (
              <OptionMenuRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ),
          )}
        </div>
      ) : null}
    </>
  );
}

type TraitsSelection = ReturnType<typeof useTraitsSelection>;

const OPTION_ROW = cn(COLUMN_ROW, "py-1.5");

/** An option's name, then the choice it opens. */
function OptionRowText(props: { label: string; value: string }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span className="min-w-0 max-w-1/2 shrink truncate text-muted-foreground text-xs">
        {props.value}
      </span>
    </>
  );
}

/**
 * One select besides reasoning, such as an agent's session mode. It names the current choice and
 * opens the rest above the row.
 */
function OptionMenuRow(props: {
  descriptor: SelectDescriptor;
  traits: TraitsSelection;
  /** Holds the column's tab stop when the model has no levels. */
  tabStop: boolean;
}) {
  const t = useUiTranslation();
  const { descriptor, traits } = props;
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const choices = selectableProviderOptionChoices(descriptor);
  const value = traits.selectValue(descriptor);
  const current = choices.find((choice) => choice.id === value)?.label ?? "";
  return (
    <Menu
      open={open}
      // A modal menu would cover the picker, so the next click there would only close it.
      modal={false}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) return;
        const checked = popupRef.current?.querySelector<HTMLElement>(
          '[role="menuitemradio"][aria-checked="true"]',
        );
        checked?.focus({ preventScroll: true });
        checked?.scrollIntoView({ block: "nearest" });
      }}
    >
      {/* No hover opening: an opened menu takes focus, which would steal typing from search. */}
      <MenuTrigger
        render={
          <button
            type="button"
            data-effort-row
            tabIndex={props.tabStop ? 0 : -1}
            aria-label={`${descriptor.label}: ${current}`}
            className={cn(OPTION_ROW, "data-popup-open:bg-foreground/[0.09]")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
          />
        }
      >
        <OptionRowText label={descriptor.label} value={current} />
        <ChevronRightIcon
          aria-hidden="true"
          className="-me-1 size-3.5 shrink-0 text-muted-foreground"
        />
      </MenuTrigger>
      <MenuPopup
        ref={popupRef}
        side="top"
        align="start"
        sideOffset={6}
        // A full-width popup on phones leaves no room above it, so fall below it.
        collisionAvoidance={{ fallbackAxisSide: "end" }}
        className="max-w-72"
        data-model-picker-option-menu
        {...composerFloatingLayerProps}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <MenuRadioGroup
          aria-label={descriptor.label}
          value={value}
          onValueChange={(next: string) => {
            if (next !== value) traits.changeSelect(descriptor, next);
          }}
        >
          {choices.map((choice) => (
            <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
              <span className="flex items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{choice.label}</span>
                  {choice.description ? (
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  ) : null}
                </span>
                {choice.isDefault ? (
                  <span className="text-muted-foreground/70 text-xs">{t("Default")}</span>
                ) : null}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** A two-state option toggles in place; a menu would add a click for nothing. */
function OptionSwitchRow(props: {
  descriptor: BooleanDescriptor;
  traits: TraitsSelection;
  tabStop: boolean;
}) {
  const gt = useGT();
  const { descriptor, traits } = props;
  const checked = descriptor.currentValue === true;
  return (
    <label className={cn(OPTION_ROW, "has-focus-visible:bg-foreground/[0.09]")}>
      <OptionRowText
        label={descriptor.label}
        value={
          checked ? gt("On", { $context: "option state" }) : gt("Off", { $context: "option state" })
        }
      />
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={(next) => traits.changeBoolean(descriptor.id, next)}
        aria-label={descriptor.label}
        data-effort-row
        tabIndex={props.tabStop ? 0 : -1}
      />
    </label>
  );
}

function NoEffortRow() {
  const t = useUiTranslation();
  return (
    <div className="flex h-9 items-center px-2.5 text-muted-foreground text-sm">
      {t("No effort levels")}
    </div>
  );
}

/**
 * The model picker's settings: the selected model's reasoning levels under a heading that names
 * it, then its other options, such as an agent's session mode, one row each.
 */
export function ComposerEffortColumn(props: { traits: TraitsSelectionInput | null }) {
  const gt = useGT();
  const messages = useMessages();
  const picker = use(DockedPickerContext);
  const visibility = props.traits
    ? getTraitsSectionVisibility({ ...props.traits, resolve: messages })
    : null;
  const controls =
    props.traits && visibility
      ? columnControls(visibility.selectDescriptors, visibility.booleanDescriptors)
      : null;
  return (
    <>
      <div className="flex h-11 shrink-0 items-baseline gap-3 px-4 text-sm">
        <span className="shrink-0 text-sm font-medium text-muted-foreground">
          {controls?.effort?.descriptor.label ??
            (controls?.others.length
              ? gt("Options", { $context: "heading for model options" })
              : gt("Effort", { $context: "heading for reasoning effort levels" }))}
        </span>
        <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">
          {picker.modelLabel}
        </span>
      </div>
      <div
        className="flex max-h-64 shrink-0 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-1 pb-1.5"
        // Capture, so Up and Down on an option row move rows instead of opening its menu.
        onKeyDownCapture={moveBetweenRows}
      >
        {props.traits ? <EffortLevels traits={props.traits} /> : <NoEffortRow />}
      </div>
    </>
  );
}

const FOOTER_SEGMENT =
  "flex h-6 cursor-pointer items-center justify-center gap-1 rounded-lg px-2.5 text-muted-foreground text-xs outline-none hover:text-foreground data-checked:bg-popover data-checked:font-semibold data-checked:text-foreground data-checked:ring-1 data-checked:ring-inset data-checked:ring-border/70 data-checked:shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function SpeedSegment(props: {
  checked: boolean;
  label: string;
  /** The untranslated speed name that picks the bolt, when `label` is translated. */
  speed?: string;
  description?: string | undefined;
  onPick: () => void;
}) {
  const speed = props.speed ?? props.label;
  const buttonProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.checked,
    "data-checked": props.checked || undefined,
    className: FOOTER_SEGMENT,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      {speed === "Fast" || speed === "Ultrafast" ? (
        <FastBolt ultra={speed === "Ultrafast"} />
      ) : null}
      {props.label}
    </>
  );
  if (!props.description) return <button {...buttonProps}>{content}</button>;
  return (
    <SharedTooltipTrigger render={<button {...buttonProps} />} label={props.description}>
      {content}
    </SharedTooltipTrigger>
  );
}

function SpeedControl(props: { traits: TraitsSelectionInput }) {
  const t = useUiTranslation();
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle } = splitSpeed(
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable || (!speedSelect && !fastToggle)) return null;
  return (
    <div
      role="radiogroup"
      aria-label={speedSelect?.label ?? fastToggle?.label}
      className="flex rounded-xl bg-foreground/[0.11] p-0.5"
    >
      {speedSelect
        ? selectableProviderOptionChoices(speedSelect).map((option) => (
            <SpeedSegment
              key={option.id}
              checked={option.id === traits.selectValue(speedSelect)}
              label={option.label}
              description={option.description}
              onPick={() => traits.changeSelect(speedSelect, option.id)}
            />
          ))
        : fastToggle
          ? ([false, true] as const).map((value) => (
              <SpeedSegment
                key={String(value)}
                checked={(fastToggle.currentValue === true) === value}
                speed={value ? "Fast" : "Standard"}
                label={t(value ? "Fast" : "Standard")}
                onPick={() => traits.changeBoolean(fastToggle.id, value)}
              />
            ))
          : null}
    </div>
  );
}

function UltracodeControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { ultracodeToggle } = splitSpeed(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable || !ultracodeToggle) return null;
  const on = ultracodeToggle.currentValue === true;
  return (
    <div className="flex rounded-xl bg-foreground/[0.11] p-0.5">
      <button
        type="button"
        aria-pressed={on}
        data-checked={on || undefined}
        className={FOOTER_SEGMENT}
        onClick={() => traits.changeBoolean(ultracodeToggle.id, !on)}
      >
        <WorkflowIcon aria-hidden="true" className="size-3" />
        {ultracodeToggle.label}
      </button>
    </div>
  );
}

/** Permissions change rarely, so the footer names the mode and nests the choice in a menu. */
function PermissionsMenu(props: {
  runtimeMode: RuntimeMode;
  options: ReadonlyArray<RuntimeModeOption>;
  onChange: (mode: RuntimeMode) => void;
}) {
  const t = useUiTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = props.options.find((option) => option.mode === props.runtimeMode);
  if (!current) return null;
  const CurrentIcon = current.icon;
  return (
    <Menu
      onOpenChangeComplete={(open) => {
        if (open) focusCheckedPermission(triggerRef.current);
      }}
    >
      <MenuTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-composer-permissions-trigger
            aria-label={t("Permissions: {name}", { name: t(current.label) })}
            className="ms-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-foreground text-xs outline-none hover:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-foreground/[0.09]"
          />
        }
      >
        <CurrentIcon aria-hidden="true" className="size-3.5" />
        {t(current.label)}
        <ChevronUpIcon aria-hidden="true" className="size-3" />
      </MenuTrigger>
      <MenuPopup side="top" align="end" {...composerFloatingLayerProps}>
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={props.options}
          onRuntimeModeChange={props.onChange}
        />
      </MenuPopup>
    </Menu>
  );
}

/** The model picker's footer: speed stays one click away, permissions sit one menu deeper. */
export function ComposerPickerFooter(props: {
  usage: ReactNode;
  traits: TraitsSelectionInput | null;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 px-3 py-2">
      {props.traits ? <SpeedControl traits={props.traits} /> : null}
      {props.traits ? <UltracodeControl traits={props.traits} /> : null}
      {props.usage}
      <PermissionsMenu
        runtimeMode={props.runtimeMode}
        options={props.runtimeModeOptions}
        onChange={props.onRuntimeModeChange}
      />
    </div>
  );
}
