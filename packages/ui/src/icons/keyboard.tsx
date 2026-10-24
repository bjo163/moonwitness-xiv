import { useId, type SVGProps } from 'react';

export type KeyboardIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function KeyboardIcon({ size = 24, title, ...props }: KeyboardIconProps) {
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
      <rect x="2.5" y="5" width="19" height="14" rx="1.5" />
      <path d="M6 9h.01m3 0h.01m3 0h.01m3 0h.01m3 0h.01M6 12h.01m3 0h.01m3 0h.01m3 0h.01m3 0h.01M7 15h10" />
    </svg>
  );
}
