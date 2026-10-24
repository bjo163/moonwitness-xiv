import { useId, type SVGProps } from 'react';

export type PhoneIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function PhoneIcon({ size = 24, title, ...props }: PhoneIconProps) {
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
      <path d="M7.2 3.5h3l1.4 4.1-2.1 1.8a15.6 15.6 0 0 0 5.1 5.1l1.8-2.1 4.1 1.4v3a2 2 0 0 1-2.2 2A16.8 16.8 0 0 1 5.2 5.7a2 2 0 0 1 2-2.2Z" />
    </svg>
  );
}
