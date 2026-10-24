import { useId, type SVGProps } from 'react';

export type JobsIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function JobsIcon({ size = 24, title, ...props }: JobsIconProps) {
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
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M9 4V2.5h6V4m-7 5h8m-8 4h8m-8 4h4" />
    </svg>
  );
}
