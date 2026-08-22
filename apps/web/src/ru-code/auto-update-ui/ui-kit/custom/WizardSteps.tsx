// ru-code: auto-update ui-kit — thin step-progress rail for the credentials wizard.
import { cn } from "../cn";

export function WizardSteps({
  total,
  current,
  className,
}: {
  total: number;
  /** 0-based index of the active step */
  current: number;
  className?: string;
}) {
  return (
    // The rail itself is decoration, so it stays `aria-hidden` — but "step 2 of 4" is information,
    // and with the rail hidden and no textual counterpart anywhere in the dialog there was no way
    // to hear where in the flow you are. The sibling span carries it for assistive tech only.
    <div className={cn("flex items-center gap-1.5", className)} data-slot="wizard-steps">
      <span className="sr-only">{`Step ${String(current + 1)} of ${String(total)}`}</span>
      {Array.from({ length: total }, (_, index) => (
        <span
          className={cn(
            "h-1 flex-1 rounded-full transition-colors duration-300",
            index < current ? "bg-success" : index === current ? "bg-primary" : "bg-border",
          )}
          key={index}
        />
      ))}
    </div>
  );
}
