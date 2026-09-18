'use client';
import { useRouter as useNextRouter } from 'next/navigation';
import * as React from 'react';

/*
 * Route transition feedback. The App Router gives no "navigation started"
 * event, so the two ways a page changes both announce themselves here:
 *  - internal <a> / <Link> clicks are caught by a capture-phase listener
 *    (see `NavigationProgress`);
 *  - programmatic navigation goes through `useAppRouter`, a drop-in for
 *    `useRouter` whose push / replace start the indicator first.
 * The indicator ends when the pathname / search params actually change
 * (or after a safety timeout), so a cancelled navigation never sticks.
 */

type Listener = (active: boolean) => void;
const listeners = new Set<Listener>();
let active = false;
let safety: ReturnType<typeof setTimeout> | null = null;

const SAFETY_MS = 8_000;

function emit(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const l of listeners) l(active);
}

export function startNavigation(): void {
  if (safety) clearTimeout(safety);
  safety = setTimeout(() => emit(false), SAFETY_MS);
  emit(true);
}

export function endNavigation(): void {
  if (safety) clearTimeout(safety);
  safety = null;
  emit(false);
}

export function useNavigationActive(): boolean {
  const [state, setState] = React.useState(active);
  React.useEffect(() => {
    listeners.add(setState);
    setState(active);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/** True once a navigation has been pending for longer than `delayMs` (avoids flicker on fast routes). */
export function useNavigationPending(delayMs = 250): boolean {
  const active = useNavigationActive();
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    if (!active) {
      setPending(false);
      return;
    }
    const timer = setTimeout(() => setPending(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return pending;
}

/** Same URL (ignoring hash) means nothing will load - do not show a bar that never ends. */
function isSameLocation(href: string): boolean {
  try {
    const target = new URL(href, window.location.href);
    return (
      target.origin === window.location.origin &&
      target.pathname === window.location.pathname &&
      target.search === window.location.search
    );
  } catch {
    return true;
  }
}

/** `useRouter` whose push / replace show the route progress indicator. */
export function useAppRouter(): ReturnType<typeof useNextRouter> {
  const router = useNextRouter();
  return React.useMemo(
    () => ({
      ...router,
      push: (href, options) => {
        if (!isSameLocation(href)) startNavigation();
        router.push(href, options);
      },
      replace: (href, options) => {
        if (!isSameLocation(href)) startNavigation();
        router.replace(href, options);
      },
    }),
    [router],
  );
}

/** Internal link clicks that will navigate (left button, no modifiers, same origin, new location). */
export function isNavigatingClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  if (!anchor) return false;
  const href = anchor.getAttribute('href') ?? '';
  const target = anchor.getAttribute('target');
  if (target && target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return false;
    if (url.pathname.startsWith('/api/')) return false;
  } catch {
    return false;
  }
  return !isSameLocation(href);
}
