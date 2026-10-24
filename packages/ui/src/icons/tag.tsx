import { useId, type SVGProps } from 'react';

export type TagIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function TagIcon({ size = 24, title, ...props }: TagIconProps) {
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
      <path d="m20.5 13.5-7 7a2 2 0 0 1-2.8 0l-7.2-7.2V3.5h9.8l7.2 7.2a2 2 0 0 1 0 2.8Z" />
      <circle cx="8" cy="8" r="1.25" />
    </svg>
  );
}
