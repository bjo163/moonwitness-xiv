import { useId, type SVGProps } from 'react';

export type UserIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function UserIcon({ size = 24, title, ...props }: UserIconProps) {
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
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c.7-3.4 3.4-5.5 7.5-5.5s6.8 2.1 7.5 5.5" />
    </svg>
  );
}
