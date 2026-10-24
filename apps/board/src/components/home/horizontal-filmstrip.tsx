'use client';

import { useId, useRef, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';

type HorizontalFilmstripProps = Omit<ComponentProps<'div'>, 'children'> & {
  children: ReactNode;
};

export function HorizontalFilmstrip({ children, ...props }: HorizontalFilmstripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const instructionsId = useId();

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const strip = stripRef.current;
    if (!strip) return;

    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      strip.scrollBy({
        left: Math.round(strip.clientWidth * 0.8) * (event.key === 'ArrowRight' ? 1 : -1),
        behavior,
      });
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      strip.scrollTo({
        left: event.key === 'Home' ? 0 : strip.scrollWidth,
        behavior,
      });
    }
  }

  return (
    <div
      {...props}
      ref={stripRef}
      tabIndex={0}
      role="region"
      aria-describedby={instructionsId}
      onKeyDown={handleKeyDown}
    >
      <span id={instructionsId} className="home-step-instructions">
        Use the left and right arrow keys to explore each step. Home and End move to the first and
        last step.
      </span>
      {children}
    </div>
  );
}
