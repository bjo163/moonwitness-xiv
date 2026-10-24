import { useId, type SVGProps } from 'react';

export type InboxIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function InboxIcon({ size = 24, title, ...props }: InboxIconProps) {
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
      <path d="M4 4.5h16l2 10v5H2v-5l2-10Z" />
      <path d="M2.5 14h5l1.7 3h5.6l1.7-3h5" />
    </svg>
  );
}
