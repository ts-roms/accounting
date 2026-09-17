'use client';
import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@accounting/ui';
import {
  endNavigation,
  isNavigatingClick,
  startNavigation,
  useNavigationActive,
} from '@/lib/navigation/progress';

/**
 * Thin progress bar under the header while the next route loads. Starts on
 * internal link clicks and programmatic navigation (`useAppRouter`), ends
 * when the location changes. CSS-only motion; under reduced motion it is a
 * static bar (see styles.css), which is still visible feedback.
 */
export function NavigationProgress() {
  const active = useNavigationActive();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = `${pathname}?${searchParams.toString()}`;

  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (isNavigatingClick(event)) startNavigation();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // The location changed: whatever was loading has arrived.
  React.useEffect(() => {
    endNavigation();
  }, [location]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5"
      role="progressbar"
      aria-label="Loading page"
      aria-hidden={!active}
      aria-busy={active}
      data-testid="route-progress"
      data-active={active ? 'true' : 'false'}
    >
      <div
        className={cn(
          'route-progress-bar h-full w-full origin-left bg-primary transition-opacity duration-fast',
          active ? 'opacity-100' : 'opacity-0',
        )}
        data-active={active ? 'true' : 'false'}
      />
    </div>
  );
}
