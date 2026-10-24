import { useId, type SVGProps } from 'react';

export type SecurityIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function SecurityIcon({ size = 24, title, ...props }: SecurityIconProps) {
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
      <path d="M12 3 20 6v5.5c0 4.6-3 7.6-8 9.5-5-1.9-8-4.9-8-9.5V6l8-3Z" />
      <path d="m8.5 12 2.3 2.3 4.8-5" />
    </svg>
  );
}
