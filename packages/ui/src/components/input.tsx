import * as React from 'react';
import { cn } from '../lib/utils';

const inputClasses =
  'flex w-full rounded-sm border border-input bg-surface text-sm text-foreground shadow-sm transition-[border-color,box-shadow,background-color] duration-fast ease-out placeholder:text-subtle-foreground hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-critical aria-invalid:focus-visible:ring-critical/30 read-only:bg-muted/60';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        inputClasses,
        'h-9 px-3 py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium',
        // Numeric / date inputs align on tabular figures like the tables they feed.
        (type === 'number' || type === 'date' || type === 'datetime-local') && 'tabular',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(inputClasses, 'min-h-[72px] px-3 py-2 leading-relaxed', className)}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export { Input, Textarea, inputClasses };
