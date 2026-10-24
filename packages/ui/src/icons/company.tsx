import { useId, type SVGProps } from 'react';

export type CompanyIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function CompanyIcon({ size = 24, title, ...props }: CompanyIconProps) {
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
      <path d="M3.5 20V8.5L10 5.5V20Z M10 11L20.5 7V20H10Z M3.5 20H20.5" />
      <path d="M6.5 10.5v1m0 3v1m6-2v1m0 3v1m4.5-8v1m0 3v1m0 3v1" />
    </svg>
  );
}
