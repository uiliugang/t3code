import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * A status strip inside the sidebar: one sentence and optional actions. `warn` is for states the
 * user probably needs to act on; everything else stays neutral so the sidebar does not shout.
 */
export function SidebarNotice({
  tone = "neutral",
  message,
  children,
}: {
  readonly tone?: "neutral" | "warn";
  readonly message: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div
      data-tone={tone}
      className={cn(
        "m-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-2.5 py-1.5 text-xs",
        tone === "warn"
          ? "bg-warning/10 text-warning-foreground"
          : "bg-sidebar-control-surface text-sidebar-muted-foreground",
      )}
    >
      {message ? (
        <p role="status" className="min-w-0 flex-1 basis-24">
          {message}
        </p>
      ) : null}
      {children}
    </div>
  );
}
