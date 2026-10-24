import { useId, type SVGProps } from 'react';

export type ModelIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function ModelIcon({ size = 24, title, ...props }: ModelIconProps) {
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
      <rect x="3.5" y="4" width="17" height="16" rx="1" />
      <path d="M3.5 9h17M9 9v11m6-11v11M3.5 14.5h17" />
    </svg>
  );
}
