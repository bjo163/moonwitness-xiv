import { useId, type SVGProps } from 'react';

export type PartnerIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function PartnerIcon({ size = 24, title, ...props }: PartnerIconProps) {
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
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.5-2.9 2.5-4.5 5.5-4.5 2.2 0 3.8.9 4.7 2.6" />
      <rect x="14" y="5" width="6.5" height="11" rx="1" />
      <path d="M15.7 8h3.1m-3.1 2.7h3.1m-3.1 2.7h1.7" />
      <path d="M15.5 20h4" />
    </svg>
  );
}
