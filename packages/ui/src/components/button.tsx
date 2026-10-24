import { Slot } from 'radix-ui';
import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';

export type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
export type ButtonSize =
  'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';
export type ButtonTreatment = 'solid' | 'brush';

export type ButtonProps = ComponentProps<'button'> & {
  asChild?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
  treatment?: ButtonTreatment;
};

export function Button({
  asChild = false,
  className,
  children,
  disabled = false,
  onClick,
  onKeyDown,
  size = 'default',
  variant = 'default',
  treatment = 'solid',
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button';
  const classes = ['mw-ui-button', className].filter(Boolean).join(' ');

  if (asChild && disabled) {
    const child = Children.only(children);
    if (!isValidElement(child)) {
      throw new Error('Button with asChild and disabled requires one valid child element.');
    }

    const childProps = child.props as { className?: string };
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      ...props,
      'aria-disabled': true,
      tabIndex: -1,
      onClick: (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      className: [childProps.className, classes].filter(Boolean).join(' '),
      'data-slot': 'button',
      'data-size': size,
      'data-treatment': treatment,
      'data-variant': variant,
    });
  }

  return (
    <Component
      data-slot="button"
      data-size={size}
      data-treatment={treatment}
      data-variant={variant}
      className={classes}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={onKeyDown}
      {...props}
    >
      {children}
    </Component>
  );
}
