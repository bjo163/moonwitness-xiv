import { useId, type SVGProps } from 'react';

export type LockIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function LockIcon({ size = 24, title, ...props }: LockIconProps) {
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
      <rect x="4.5" y="10" width="15" height="11" rx="1.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
    </svg>
  );
}
