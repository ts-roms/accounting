'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Kbd,
} from '@accounting/ui';
import { GO_TO, SHORTCUTS } from '@/lib/navigation';

const isEditable = (el: Element | null) =>
  !!el &&
  (el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el as HTMLElement).isContentEditable);

/**
 * Global keyboard shortcuts. Only Ctrl+K / Ctrl+/ / Ctrl+B are claimed from
 * the browser; single-key chords (`?`, `g d`) fire only outside text inputs.
 */
export function useGlobalShortcuts({
  onCommandPalette,
  onSearch,
  onToggleSidebar,
  onShowShortcuts,
}: {
  onCommandPalette: () => void;
  onSearch: () => void;
  onToggleSidebar: () => void;
  onShowShortcuts: () => void;
}) {
  const router = useRouter();
  const pendingG = React.useRef<number | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'k') {
        e.preventDefault();
        onCommandPalette();
        return;
      }
      if (mod && key === '/') {
        e.preventDefault();
        onSearch();
        return;
      }
      if (mod && key === 'b') {
        e.preventDefault();
        onToggleSidebar();
        return;
      }
      if (mod || e.altKey || isEditable(document.activeElement)) return;
      if (e.key === '?') {
        e.preventDefault();
        onShowShortcuts();
        return;
      }
      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const href = GO_TO[key];
        if (href) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      if (key === 'g') {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 800);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCommandPalette, onSearch, onToggleSidebar, onShowShortcuts, router]);
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Chords such as G then D are typed in sequence.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map((s) => (
            <React.Fragment key={s.description}>
              <dt className="text-muted-foreground">{s.description}</dt>
              <dd className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dd>
            </React.Fragment>
          ))}
          <dt className="text-muted-foreground">Move between rows / menu items</dt>
          <dd className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </dd>
          <dt className="text-muted-foreground">Confirm / open selection</dt>
          <dd>
            <Kbd>Enter</Kbd>
          </dd>
        </dl>
      </DialogContent>
    </Dialog>
  );
}
