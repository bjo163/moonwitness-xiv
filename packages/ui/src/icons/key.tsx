import { useId, type SVGProps } from 'react';

export type KeyIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function KeyIcon({ size = 24, title, ...props }: KeyIconProps) {
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
      <circle cx="8" cy="15.5" r="4.5" />
      <path d="m11.2 12.3 9.3-9.3m-3.5 3.5 2.5 2.5m-5-0 2.5 2.5" />
    </svg>
  );
}
