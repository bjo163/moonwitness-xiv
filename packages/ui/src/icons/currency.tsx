import { useId, type SVGProps } from 'react';

export type CurrencyIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function CurrencyIcon({ size = 24, title, ...props }: CurrencyIconProps) {
  const titleId = useId();
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
      height={size}
      role={title ? 'img' : undefined}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5c-.7-.7-1.8-1-3-1-1.8 0-3 .9-3 2.2 0 3.2 5.8 1.2 5.8 4.4 0 1.3-1.2 2.4-3.2 2.4-1.2 0-2.5-.4-3.4-1.3M12 6v12" />
    </svg>
  );
}
