'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';

export function useDialogFocus(onClose: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  // Keep Escape's handler current without restarting the dialog's focus lifecycle.
  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    containerRef.current?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      // Escape can cancel a Chinese input candidate; leave that event to the IME.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;

      const controls = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? [],
      );
      if (!controls.length) return;
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === controls.at(-1) || document.activeElement === containerRef.current)
      ) {
        event.preventDefault();
        controls[0].focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus({ preventScroll: true });
    };
  }, []);

  return containerRef;
}
