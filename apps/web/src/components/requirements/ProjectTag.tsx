import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

export function ProjectTag({ title }: { title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex max-w-48 min-w-0 items-center rounded bg-secondary px-1.5 py-0.5 text-xs font-normal text-muted-foreground" />
        }
      >
        <span className="truncate">{title}</span>
      </TooltipTrigger>
      <TooltipPopup>{title}</TooltipPopup>
    </Tooltip>
  );
}
