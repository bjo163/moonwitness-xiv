import { useId, type SVGProps } from 'react';

export type SettingsIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function SettingsIcon({ size = 24, title, ...props }: SettingsIconProps) {
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
      <path d="M12 3.5v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.5-6-1.4 1.4m-9.2 9.2L6 18m12 0-1.4-1.4m-9.2-9.2L6 6" />
      <circle cx="12" cy="12" r="6.3" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}
