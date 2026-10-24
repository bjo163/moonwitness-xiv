import { useId, type SVGProps } from 'react';

export type CalendarIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function CalendarIcon({ size = 24, title, ...props }: CalendarIconProps) {
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
      <rect x="3.5" y="5" width="17" height="16" rx="1.5" />
      <path d="M7.5 3v4m9-4v4m-13 2h17m-12 4h.1m4.9 0h.1m-5.1 4h.1m4.9 0h.1" />
    </svg>
  );
}
