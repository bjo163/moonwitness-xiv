'use client';

import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { useAnimationVisibility } from '../lib/use-animation-visibility.js';

export type SkeletonProps = ComponentProps<'div'> & {
  label?: string;
};

export function Skeleton({ className, label, ref: externalRef, ...props }: SkeletonProps) {
  const motion = useAnimationVisibility<HTMLDivElement>(externalRef);
  return (
    <div
      ref={motion.ref}
      aria-busy="true"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('mw-ui-skeleton', motion.visibilityClass, className)}
      data-slot="skeleton"
      role={label ? 'status' : undefined}
      {...props}
    />
  );
}
