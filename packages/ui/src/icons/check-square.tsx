import { useId, type SVGProps } from 'react';

export type CheckSquareIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function CheckSquareIcon({ size = 24, title, ...props }: CheckSquareIconProps) {
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
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
      <path d="m7.5 12.5 3 3 6-7" />
    </svg>
  );
}
