import { useId, type SVGProps } from 'react';

export type WorkflowIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function WorkflowIcon({ size = 24, title, ...props }: WorkflowIconProps) {
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
      <rect x="3.5" y="3.5" width="6" height="5" rx="1" />
      <rect x="14.5" y="15.5" width="6" height="5" rx="1" />
      <circle cx="17.5" cy="6" r="2.5" />
      <path d="M9.5 6h3.5a4.5 4.5 0 0 1 4.5 4.5v5m-14-7v4.5a3.5 3.5 0 0 0 3.5 3.5h7.5" />
    </svg>
  );
}
