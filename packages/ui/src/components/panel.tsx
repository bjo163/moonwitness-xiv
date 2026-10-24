import type { ComponentProps, ReactNode } from 'react';

export type PanelProps = Omit<ComponentProps<'section'>, 'children' | 'title'> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  surface?: 'default' | 'ink' | 'paper';
  frame?: 'line' | 'torn';
  density?: 'comfortable' | 'compact';
  headingLevel?: 2 | 3 | 4;
};

export function Panel({
  title,
  description,
  actions,
  children,
  surface = 'default',
  frame = 'line',
  density = 'comfortable',
  headingLevel = 2,
  className,
  ...props
}: PanelProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      className={['mw-ui-panel', className].filter(Boolean).join(' ')}
      data-density={density}
      data-frame={frame}
      data-surface={surface}
      {...props}
    >
      {title || description || actions ? (
        <header className="mw-ui-panel-header">
          <div>
            {title ? <Heading className="mw-ui-panel-title">{title}</Heading> : null}
            {description ? <p className="mw-ui-panel-description">{description}</p> : null}
          </div>
          {actions ? <div className="mw-ui-panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="mw-ui-panel-content">{children}</div>
    </section>
  );
}
