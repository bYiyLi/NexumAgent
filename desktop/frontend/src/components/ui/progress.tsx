import { Progress } from "@base-ui/react/progress";
import "./progress.css";

export function progressPercent(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, Math.floor(value)));
}

export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const percent = progressPercent(value);
  return (
    <Progress.Root className="desktop-progress" value={percent} aria-label={label}>
      <Progress.Track className="desktop-progress-track">
        <Progress.Indicator className="desktop-progress-indicator" />
      </Progress.Track>
    </Progress.Root>
  );
}
