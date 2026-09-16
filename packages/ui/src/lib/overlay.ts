/**
 * Shared classes for floating surfaces (dropdowns, popovers, selects,
 * tooltips). One place defines the elevated surface and the quiet
 * enter/exit motion: fade + 98% scale + 4px slide toward the trigger.
 */
export const overlaySurface =
  'z-50 rounded-md border border-border bg-popover text-popover-foreground shadow-lg';

export const overlayMotion =
  'data-[state=open]:animate-enter-fast data-[state=open]:fade-in data-[state=open]:scale-in-98 data-[state=closed]:animate-exit data-[state=closed]:fade-out data-[side=bottom]:slide-in-down-1 data-[side=top]:slide-in-up-1 data-[side=left]:slide-in-right-1 data-[side=right]:slide-in-left-1 origin-[var(--radix-popper-transform-origin)]';

/** Tooltips: opacity + 2px only, no scale. */
export const tooltipMotion =
  'data-[state=delayed-open]:animate-enter-fast data-[state=delayed-open]:fade-in data-[state=instant-open]:animate-enter-fast data-[state=instant-open]:fade-in data-[state=closed]:animate-exit data-[state=closed]:fade-out data-[side=bottom]:slide-in-down-1 data-[side=top]:slide-in-up-1 data-[side=left]:slide-in-right-1 data-[side=right]:slide-in-left-1';

export const menuItemClasses =
  'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors duration-fast focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
