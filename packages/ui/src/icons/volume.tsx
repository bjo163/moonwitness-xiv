import { useId, type SVGProps } from 'react';

export type VolumeIconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function VolumeIcon({ size = 24, title, ...props }: VolumeIconProps) {
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
      <path d="M4 10v4h4l5 4V6l-5 4H4Zm12-1a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12" />
    </svg>
  );
}
