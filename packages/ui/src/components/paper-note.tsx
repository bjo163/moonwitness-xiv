import type { ComponentProps, ReactNode } from 'react';

export type PaperNoteProps = Omit<ComponentProps<'aside'>, 'children'> & {
  children: ReactNode;
  accent?: 'magenta' | 'cyan' | 'yellow';
  rotation?: 'none' | 'subtle';
};

/** Editorial callout: its words remain selectable HTML and its shape stays non-interactive. */
export function PaperNote({
  children,
  accent = 'yellow',
  rotation = 'subtle',
  className,
  ...props
}: PaperNoteProps) {
  return (
    <aside
      className={['mw-ui-paper-note', className].filter(Boolean).join(' ')}
      data-accent={accent}
      data-rotation={rotation}
      {...props}
    >
      {children}
    </aside>
  );
}
