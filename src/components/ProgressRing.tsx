interface ProgressRingProps {
  done: number;
  total: number;
  size: number;
}

export function ProgressRing({ done, total, size }: ProgressRingProps) {
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  const fraction = Number.isFinite(total) && total > 0
    ? Math.min(total, Math.max(0, Number.isNaN(done) ? 0 : done)) / total
    : 0;

  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="shrink-0 -rotate-90">
      <circle cx="20" cy="20" r={radius} fill="none" strokeWidth="3" className="stroke-line-strong dark:stroke-ink-faint" />
      <circle
        cx="20" cy="20" r={radius} fill="none" strokeWidth="3"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        className="stroke-gold transition-[stroke-dashoffset] duration-(--dur-base) ease-shutfey motion-reduce:transition-none"
      />
    </svg>
  );
}
