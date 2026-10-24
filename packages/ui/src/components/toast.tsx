'use client';

import { Toaster as SonnerToaster, toast } from 'sonner';
import { createPortal } from 'react-dom';
import { useEffect, useState, type ComponentProps } from 'react';

export { toast };

export type ToastHostProps = ComponentProps<typeof SonnerToaster>;

/** Mount once near the application root so package toast calls are visible. */
export function ToastHost({
  position = 'bottom-right',
  closeButton = true,
  richColors = true,
  className,
  ...props
}: ToastHostProps) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  if (!portalTarget) return null;
  const hostClassName = ['mw-ui-toast-host', className].filter(Boolean).join(' ');
  return createPortal(
    <SonnerToaster
      position={position}
      closeButton={closeButton}
      richColors={richColors}
      {...props}
      className={hostClassName}
    />,
    portalTarget
  );
}
