import { useId, type SVGProps } from 'react';

export type SignalIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function SignalIcon({ size = 24, title, ...props }: SignalIconProps) {
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
      <path d="M4 18a11 11 0 0 1 16 0M7 15a7 7 0 0 1 10 0m-7-3a3 3 0 0 1 4 0m-2 6v.1" />
    </svg>
  );
}
