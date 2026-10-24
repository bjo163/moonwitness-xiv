import { useId, type SVGProps } from 'react';

export type VisibilityOffIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function VisibilityOffIcon({ size = 24, title, ...props }: VisibilityOffIconProps) {
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
      <path d="m3 3 18 18M10.6 6.6c.5-.1.9-.1 1.4-.1 6.3 0 9.5 5.5 9.5 5.5a16 16 0 0 1-3 3.7M6.2 6.8C3.8 8.3 2.5 12 2.5 12s3.2 5.5 9.5 5.5c.8 0 1.6-.1 2.3-.3" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
