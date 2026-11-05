import type { ComponentProps } from "react";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { useUiTranslation } from "~/hooks/useUiTranslation";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  const t = useUiTranslation();
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? t("Continue with ChatGPT")}
    </Button>
  );
}
