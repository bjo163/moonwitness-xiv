import { useId, type SVGProps } from 'react';

export type CreditCardIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function CreditCardIcon({ size = 24, title, ...props }: CreditCardIconProps) {
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
      <path d="M3 9h18m-15 6h4m-4 2h2" />
    </svg>
  );
}
