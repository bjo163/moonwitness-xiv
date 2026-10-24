import { useId, type SVGProps } from 'react';

export type TeamIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function TeamIcon({ size = 24, title, ...props }: TeamIconProps) {
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
      <circle cx="12" cy="7" r="2.8" />
      <circle cx="5" cy="9" r="2.1" />
      <circle cx="19" cy="9" r="2.1" />
      <path d="M7 19c.4-3.2 2-4.8 5-4.8s4.6 1.6 5 4.8m-14.5-.5c.3-2.3 1.3-3.5 3.2-3.8m13.8 3.8c-.3-2.3-1.3-3.5-3.2-3.8" />
    </svg>
  );
}
