import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getTraitSelectChange,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import {
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
} from "@t3tools/shared/model";
import { msg, useMessages } from "gt-react";
import { memo } from "react";
import { GaugeIcon } from "lucide-react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuState } from "./useComposerMenuState";
import {
  getTraitsSectionVisibility,
  type PromptUltrathink,
  type ProviderOptions,
} from "./traitsSelection.logic";

export {
  getTraitsSectionVisibility,
  readPromptUltrathink,
  type PromptUltrathink,
} from "./traitsSelection.logic";

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      /** Runs after a change is written to the draft. */
      onDraftModelOptionsChange?: () => void;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onDraftModelOptionsChange?: never;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function DefaultBadge() {
  const t = useUiTranslation();
  return (
    <Badge variant="outline" size="sm" className="min-w-0">
      {t("Default")}
    </Badge>
  );
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  /** Receives an edit of the live prompt; the picker never holds the prompt text itself. */
  onPromptEdit?: (edit: (prompt: string) => string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  allowPromptInjectedEffort?: boolean;
  includePlanAgent?: boolean | undefined;
  triggerClassName?: string;
}

export type TraitsSelectionInput = TraitsMenuContentProps & TraitsPersistence;

/** The model's traits with their shown values, and writers that persist a change. */
export function useTraitsSelection({
  provider,
  instanceId,
  models,
  model,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  includePlanAgent,
  triggerClassName: _triggerClassName,
  ...persistence
}: TraitsSelectionInput) {
  const modelSelection =
    instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const resolve = useMessages();
  const updateModelOptions = (nextOptions: ProviderOptions | undefined) => {
    if ("onModelOptionsChange" in persistence) {
      persistence.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = persistence.threadRef ?? persistence.draftId;
    if (!threadTarget) {
      return;
    }
    setProviderModelOptions(threadTarget, provider, nextOptions, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
    persistence.onDraftModelOptionsChange?.();
  };
  const selected = getTraitsSectionVisibility({
    provider,
    models,
    model,
    promptUltrathink,
    modelOptions,
    allowPromptInjectedEffort,
    includePlanAgent,
    resolve,
  });
  return {
    ...selected,
    /** The option a select shows, where an Ultrathink prompt owns the primary select. */
    selectValue: (descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>) =>
      selected.ultrathinkPromptControlled && descriptor.id === selected.primarySelectDescriptor?.id
        ? "ultrathink"
        : (getDescriptorStringValue(descriptor, modelSelection, reportedModelSelection) ?? ""),
    currentLabel: (descriptor: ProviderOptionDescriptor) =>
      getProviderOptionCurrentLabel(descriptor, modelSelection, reportedModelSelection),
    changeSelect: (
      descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
      value: string,
    ) => {
      // Whether a pick applies, and the options it writes, do not depend on the prompt text.
      const change = getTraitSelectChange(selected, descriptor, "", value);
      if (!change) return;
      onPromptEdit?.(
        (prompt) => getTraitSelectChange(selected, descriptor, prompt, value)?.prompt ?? prompt,
      );
      updateModelOptions(change.modelOptions);
    },
    changeBoolean: (descriptorId: string, value: boolean) => {
      updateModelOptions(
        buildProviderOptionSelectionsFromDescriptors(
          replaceDescriptorCurrentValue(selected.descriptors, descriptorId, value),
        ),
      );
    },
  };
}

export const ULTRATHINK_IN_BODY_NOTE = msg(
  'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
);

const TraitsMenuContent = memo(function TraitsMenuContentImpl(props: TraitsSelectionInput) {
  const t = useUiTranslation();
  const traits = useTraitsSelection(props);
  const resolve = useMessages();
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkInBodyText,
    hasAnyControls,
    modelIsUnavailable,
  } = traits;

  if (!hasAnyControls) {
    return null;
  }

  if (modelIsUnavailable) {
    return (
      <>
        {descriptors.map((descriptor, index) => {
          const value = traits.currentLabel(descriptor);
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuDivider /> : null}
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  {descriptor.label}
                </div>
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
              </MenuGroup>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                {resolve(ULTRATHINK_IN_BODY_NOTE)}
              </div>
            ) : null}
            <MenuRadioGroup
              value={traits.selectValue(descriptor)}
              onValueChange={(value) => traits.changeSelect(descriptor, value)}
            >
              {selectableProviderOptionChoices(descriptor).map((option) => (
                <MenuRadioItem
                  key={option.id}
                  value={option.id}
                  hideIndicator
                  closeOnClick
                  disabled={ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id}
                >
                  <span className="flex w-full min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate">{option.label}</span>
                      {option.isDefault ? <DefaultBadge /> : null}
                    </span>
                    {option.description ? (
                      <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
      {booleanDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            <MenuRadioGroup
              value={descriptor.currentValue === true ? "on" : "off"}
              onValueChange={(value) => traits.changeBoolean(descriptor.id, value === "on")}
            >
              {(["on", "off"] as const).map((value) => (
                <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
                  <span className="flex w-full min-w-0 items-center justify-between gap-3">
                    <span>{t(value === "on" ? "On" : "Off")}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  size = "sm",
  hidden = false,
  disabled = false,
  ...props
}: TraitsSelectionInput & {
  size?: ComposerControlSize;
  hidden?: boolean;
  disabled?: boolean;
}) {
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled);
  const traits = useTraitsSelection(props);
  const resolve = useMessages();
  if (!traits.hasAnyControls) {
    return null;
  }
  const { label: triggerLabel } = buildTraitsTriggerDisplay(
    {
      descriptors: traits.descriptors,
      primarySelectDescriptorId: traits.primarySelectDescriptor?.id ?? null,
      ultrathinkPromptControlled: traits.ultrathinkPromptControlled,
      modelSelection:
        props.instanceId && props.model
          ? { instanceId: props.instanceId, model: props.model, options: props.modelOptions ?? [] }
          : null,
      reportedModelSelection: props.reportedModelSelection,
    },
    resolve,
  );
  const isCodexStyle = props.provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  disabled={disabled}
                  aria-label={triggerLabel}
                  size={size}
                  className={cn(
                    isCodexStyle
                      ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                      : "shrink-0 whitespace-nowrap",
                    props.triggerClassName,
                  )}
                />
              }
            />
          }
        >
          {isCodexStyle ? (
            <span
              className={cn(
                "flex min-w-0 w-full items-center",
                size === "xs" ? "gap-1" : "gap-1.5",
              )}
            >
              <ComposerControlIcon icon={GaugeIcon} size={size} />
              <span data-composer-control-label className="min-w-0 truncate">
                {triggerLabel}
              </span>
            </span>
          ) : (
            <>
              <ComposerControlIcon icon={GaugeIcon} size={size} />
              <span data-composer-control-label>{triggerLabel}</span>
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start">
        <TraitsMenuContent {...props} />
      </MenuPopup>
    </Menu>
  );
});
