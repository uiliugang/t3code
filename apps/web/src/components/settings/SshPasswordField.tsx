import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useId, useState, type KeyboardEventHandler } from "react";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SshPasswordField({
  value,
  onChange,
  placeholder,
  disabled,
  onKeyDown,
  autoFocus,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  disabled: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  autoFocus?: boolean;
  required?: boolean;
}) {
  const t = useUiTranslation();
  const id = useId();
  const [visible, setVisible] = useState(false);
  const show = visible && value !== "";
  const label = t(show ? "Hide password" : "Show password");
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium">
        {t("SSH password")}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          autoFocus={autoFocus}
          type={show ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            if (event.target.value === "") setVisible(false);
            onChange(event.target.value);
          }}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={onKeyDown}
          required={required}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon"
                variant="outline"
                disabled={disabled || !value}
                aria-label={label}
                aria-pressed={show}
                onClick={() => setVisible(!show)}
              />
            }
          >
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </TooltipTrigger>
          <TooltipPopup>{label}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
