import type { ComponentProps, ReactNode } from 'react';

export type ArtworkFrameProps = Omit<ComponentProps<'figure'>, 'children'> & {
  children: ReactNode;
  shape?: 'landscape' | 'portrait' | 'square';
  caption?: ReactNode;
  surface?: 'ink' | 'paper';
};

/** Media frame; callers provide optimized images and accurate alt text. */
export function ArtworkFrame({
  children,
  shape = 'landscape',
  caption,
  surface = 'ink',
  className,
  ...props
}: ArtworkFrameProps) {
  return (
    <figure
      className={['mw-ui-artwork-frame', className].filter(Boolean).join(' ')}
      data-shape={shape}
      data-surface={surface}
      {...props}
    >
      <div className="mw-ui-artwork-frame-media" data-surface={surface}>
        {children}
      </div>
      {caption ? <figcaption className="mw-ui-artwork-frame-caption">{caption}</figcaption> : null}
    </figure>
  );
}
