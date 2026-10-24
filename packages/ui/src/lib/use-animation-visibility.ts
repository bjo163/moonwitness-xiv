import { useCallback, useEffect, useRef, useState, type Ref } from 'react';

/** Pause decorative and pending-state CSS animations while their element is offscreen. */
export function useAnimationVisibility<T extends Element>(externalRef?: Ref<T>) {
  const elementRef = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const ref = useCallback(
    (element: T | null) => {
      elementRef.current = element;
      if (typeof externalRef === 'function') externalRef(element);
      else if (externalRef) externalRef.current = element;
    },
    [externalRef]
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting && entry.intersectionRatio > 0),
      { threshold: 0 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return {
    ref,
    visibilityClass: isVisible ? 'mw-ui-motion-visible' : 'mw-ui-motion-paused',
  };
}
