import { cn } from '@/lib/utils';

/** Use the canonical generated lockup or symbol variant from @moonwitness/assets. */
export function Logo({
  className,
  compact = false,
  surface = 'dark',
  decorative = false,
}: {
  className?: string;
  compact?: boolean;
  surface?: 'light' | 'dark';
  decorative?: boolean;
}) {
  const kind = compact ? 'symbol' : 'lockup';
  return (
    <img
      src={`/brand/moonwitness-${kind}-${surface}.svg`}
      alt={decorative ? '' : 'MoonWitness'}
      aria-hidden={decorative || undefined}
      width={compact ? 64 : 520}
      height={compact ? 64 : 80}
      className={cn(compact ? 'size-8' : 'h-8 w-[12.5rem] object-contain object-left', className)}
    />
  );
}
