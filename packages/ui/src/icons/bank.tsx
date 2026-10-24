import { useId, type SVGProps } from 'react';

export type BankIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function BankIcon({ size = 24, title, ...props }: BankIconProps) {
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
      <path d="m3 9 9-5 9 5M4 10h16M5 10v9m4-9v9m6-9v9m4-9v9M3 20h18M2.5 22h19" />
    </svg>
  );
}
