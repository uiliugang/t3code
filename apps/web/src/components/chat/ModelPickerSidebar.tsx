import { useUiTranslation } from "../../hooks/useUiTranslation";
import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, type Dispatch, type SetStateAction, useLayoutEffect, useRef, useState } from "react";
import { msg, useMessages } from "gt-react";
import { StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { MessageResolver } from "../../i18n/messages";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";

function describeUnavailableInstance(
  entry: ProviderInstanceEntry,
  resolve: MessageResolver,
): string {
  const label = entry.displayName;
  // An unavailable instance (a driver this build lacks or the policy leaves out) says why instead.
  if ((!entry.enabled && entry.isAvailable) || entry.status === "disabled") {
    return resolve(msg("{label}: Disabled in settings.", { label }));
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const message = entry.snapshot.message?.trim();
  if (message) {
    return resolve(
      entry.status === "error"
        ? msg("{label}: Unavailable. {message}", { label, message })
        : entry.status === "warning"
          ? msg("{label}: Limited. {message}", { label, message })
          : msg("{label}: Not ready. {message}", { label, message }),
    );
  }
  return resolve(
    entry.status === "error"
      ? msg("{label}: Unavailable.", { label })
      : entry.status === "warning"
        ? msg("{label}: Limited.", { label })
        : msg("{label}: Not ready.", { label }),
  );
}

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

const ModelPickerSidebarItem = memo(function ModelPickerSidebarItem(props: {
  entry: ProviderInstanceEntry;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  horizontal?: boolean;
  selected: boolean;
  hovered: boolean;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  getDisabledInstanceTooltip: ((entry: ProviderInstanceEntry) => string) | undefined;
  messageResolver: MessageResolver;
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  setHoveredInstanceId: Dispatch<SetStateAction<ProviderInstanceId | null>>;
}) {
  const isUnavailable = !isProviderInstancePickerReady(props.entry);
  const isContextDisabled = props.disabledInstanceIds?.has(props.entry.instanceId) ?? false;
  const unavailableSelectionIsReachable =
    props.selectableUnavailableInstanceIds?.has(props.entry.instanceId) ?? false;
  const isDisabled = (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
  const showInstanceBadge = shouldShowInstanceBadge(props.entry, props.instanceEntries);
  const tooltip = isUnavailable
    ? describeUnavailableInstance(props.entry, props.messageResolver)
    : isContextDisabled
      ? (props.getDisabledInstanceTooltip?.(props.entry) ?? props.entry.displayName)
      : props.entry.displayName;

  const button = (
    <Toolbar.Button
      className={cn(
        "relative isolate flex shrink-0 cursor-pointer items-center justify-center transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
        props.horizontal
          ? "size-9 rounded-lg aria-pressed:bg-foreground/[0.11]"
          : "aspect-square w-full rounded-md",
        isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
      )}
      data-provider-accent-color={props.entry.accentColor}
      onClick={() => !isDisabled && props.onSelectInstance(props.entry.instanceId)}
      onMouseEnter={() => props.setHoveredInstanceId(props.entry.instanceId)}
      onMouseLeave={() =>
        props.setHoveredInstanceId((current) =>
          current === props.entry.instanceId ? null : current,
        )
      }
      onFocus={() => props.setHoveredInstanceId(props.entry.instanceId)}
      onBlur={() =>
        props.setHoveredInstanceId((current) =>
          current === props.entry.instanceId ? null : current,
        )
      }
      disabled={isDisabled}
      focusableWhenDisabled={!isDisabled}
      aria-pressed={props.selected}
      type="button"
      aria-label={isUnavailable || isContextDisabled ? tooltip : props.entry.displayName}
    >
      <ProviderInstanceIcon
        driverKind={props.entry.driverKind}
        displayName={props.entry.displayName}
        accentColor={props.entry.accentColor}
        acpRegistryAgentId={props.entry.acpRegistryAgentId}
        acpRegistryIconUrl={props.entry.acpRegistryIconUrl}
        showBadge={showInstanceBadge}
        className="size-6 z-30"
        iconClassName="size-5"
        indicatorBackground={
          props.hovered && !isDisabled
            ? "var(--muted)"
            : props.selected
              ? "var(--background)"
              : "color-mix(in oklab, var(--muted) 30%, transparent)"
        }
        {...(props.entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
      />
    </Toolbar.Button>
  );

  const trigger = isDisabled ? (
    <span className="relative block w-full shrink-0">{button}</span>
  ) : (
    button
  );

  return (
    <div
      className={props.horizontal ? "relative shrink-0" : "relative w-full"}
      data-model-picker-provider={props.entry.instanceId}
    >
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipPopup
          side={props.horizontal ? "top" : PICKER_TOOLTIP_SIDE}
          sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
          align="center"
        >
          {tooltip}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

type SidebarProps = {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
};

function FavoritesTab(props: { selected: boolean; horizontal: boolean; onSelect: () => void }) {
  const t = useUiTranslation();
  return (
    <div
      className={props.horizontal ? "relative shrink-0" : "relative w-full"}
      data-model-picker-provider="favorites"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Toolbar.Button
              className={cn(
                "relative isolate flex shrink-0 cursor-pointer items-center justify-center transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
                props.horizontal
                  ? "size-9 rounded-lg aria-pressed:bg-foreground/[0.11] aria-pressed:text-primary"
                  : "aspect-square w-full rounded-md",
              )}
              onClick={props.onSelect}
              type="button"
              aria-label={t("Favorites")}
              aria-pressed={props.selected}
            >
              <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
            </Toolbar.Button>
          }
        />
        <TooltipPopup
          side={props.horizontal ? "top" : PICKER_TOOLTIP_SIDE}
          sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
          align="center"
        >
          {t("Favorites")}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The tabs along the picker's top edge: providers in a row, with the favorites first. */
function HorizontalModelPickerSidebar(props: SidebarProps & { onFocusList?: () => void }) {
  const t = useUiTranslation();
  const m = useMessages();
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  return (
    <Toolbar.Root
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-model-picker-sidebar="true"
      aria-label={t("Providers")}
      orientation="horizontal"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          props.onFocusList?.();
        }
      }}
    >
      {(props.showFavorites ?? true) ? (
        <FavoritesTab
          horizontal
          selected={props.selectedInstanceId === "favorites"}
          onSelect={() => props.onSelectInstance("favorites")}
        />
      ) : null}
      {props.instanceEntries.map((entry) => (
        <ModelPickerSidebarItem
          key={entry.instanceId}
          horizontal
          entry={entry}
          instanceEntries={props.instanceEntries}
          selected={props.selectedInstanceId === entry.instanceId}
          hovered={hoveredInstanceId === entry.instanceId}
          disabledInstanceIds={props.disabledInstanceIds}
          selectableUnavailableInstanceIds={props.selectableUnavailableInstanceIds}
          getDisabledInstanceTooltip={props.getDisabledInstanceTooltip}
          messageResolver={m}
          onSelectInstance={props.onSelectInstance}
          setHoveredInstanceId={setHoveredInstanceId}
        />
      ))}
    </Toolbar.Root>
  );
}

const VerticalModelPickerSidebar = memo(function VerticalModelPickerSidebar(props: SidebarProps) {
  const t = useUiTranslation();
  const m = useMessages();
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  // The selected tab's row: favorites first, then the entries in order. -1 when it is not shown.
  const selectedRow =
    props.selectedInstanceId === "favorites"
      ? showFavorites
        ? 0
        : -1
      : props.instanceEntries.findIndex((entry) => entry.instanceId === props.selectedInstanceId) +
        (showFavorites ? 1 : 0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected provider item's DOM offset to position the selection indicator
  useLayoutEffect(() => {
    // Adding, removing or reordering providers moves the selected row, so the indicator re-measures.
    const selectedItem =
      selectedRow < 0
        ? undefined
        : sidebarContentRef.current?.querySelectorAll<HTMLElement>("[data-model-picker-provider]")[
            selectedRow
          ];
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [selectedRow]);

  return (
    <Toolbar.Root
      className="w-11 shrink-0 overflow-hidden bg-muted/30"
      data-model-picker-sidebar="true"
      aria-label={t("Providers")}
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-primary transition-[top] duration-200 ease-out"
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <FavoritesTab
                horizontal={false}
                selected={props.selectedInstanceId === "favorites"}
                onSelect={() => props.onSelectInstance("favorites")}
              />
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}

          {props.instanceEntries.map((entry) => (
            <ModelPickerSidebarItem
              key={entry.instanceId}
              entry={entry}
              instanceEntries={props.instanceEntries}
              selected={props.selectedInstanceId === entry.instanceId}
              hovered={hoveredInstanceId === entry.instanceId}
              disabledInstanceIds={props.disabledInstanceIds}
              selectableUnavailableInstanceIds={props.selectableUnavailableInstanceIds}
              getDisabledInstanceTooltip={props.getDisabledInstanceTooltip}
              messageResolver={m}
              onSelectInstance={props.onSelectInstance}
              setHoveredInstanceId={setHoveredInstanceId}
            />
          ))}
        </div>
      </div>
    </Toolbar.Root>
  );
});

export const ModelPickerSidebar = memo(function ModelPickerSidebar(
  props: SidebarProps & {
    /** `horizontal` runs the tabs along the picker's top edge instead of down its left side. */
    orientation?: "vertical" | "horizontal";
    /** Arrow Down on a horizontal tab row moves into the models. */
    onFocusList?: () => void;
  },
) {
  const { orientation = "vertical", onFocusList, ...rest } = props;
  return orientation === "horizontal" ? (
    <HorizontalModelPickerSidebar {...rest} {...(onFocusList ? { onFocusList } : {})} />
  ) : (
    <VerticalModelPickerSidebar {...rest} />
  );
});
