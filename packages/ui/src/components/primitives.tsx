'use client';
/* Small, stateless primitives grouped in one module: Label, Card, Badge, Separator, Skeleton, Kbd. */
import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

// ---------------------------------------------------------------------- Label
const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean }
>(({ className, required, children, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  >
    {children}
    {required ? (
      <span className="ml-0.5 text-critical" aria-hidden>
        *
      </span>
    ) : null}
  </LabelPrimitive.Root>
));
Label.displayName = 'Label';

// ----------------------------------------------------------------------- Card
type DivProps = React.HTMLAttributes<HTMLDivElement>;
const div = (name: string, classes: string) => {
  const C = React.forwardRef<HTMLDivElement, DivProps>(({ className, ...props }, ref) => (
    <div ref={ref} className={cn(classes, className)} {...props} />
  ));
  C.displayName = name;
  return C;
};

/** Surface card. Hierarchy comes from the border and surface colour, not a shadow. */
const Card = div('Card', 'rounded-lg border bg-card text-card-foreground');
const CardHeader = div('CardHeader', 'flex flex-col space-y-1 p-4');
const CardTitle = div('CardTitle', 'type-h3 leading-none tracking-tight');
const CardDescription = div('CardDescription', 'text-xs text-muted-foreground');
const CardContent = div('CardContent', 'p-4 pt-0');
const CardFooter = div('CardFooter', 'flex items-center p-4 pt-0');

// ---------------------------------------------------------------------- Badge
/**
 * Badge tones follow the financial semantic palette. Legacy shadcn names
 * (`success`, `destructive`) remain as aliases so existing call sites keep
 * working; new code should use `positive` / `critical` / `warning` / `info`.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-medium leading-4 whitespace-nowrap transition-colors duration-fast',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        positive: 'border-positive/25 bg-positive/10 text-positive',
        warning: 'border-warning/30 bg-warning/10 text-warning',
        critical: 'border-critical/25 bg-critical/10 text-critical',
        info: 'border-info/25 bg-info/10 text-info',
        neutral: 'border-border bg-muted text-muted-foreground',
        // aliases
        success: 'border-positive/25 bg-positive/10 text-positive',
        destructive: 'border-critical/25 bg-critical/10 text-critical',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Leading status dot so the badge never relies on colour + text alone. */
  dot?: boolean;
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, dot, children, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  ),
);
Badge.displayName = 'Badge';

// ------------------------------------------------------------------ Separator
const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      'shrink-0 bg-border',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className,
    )}
    {...props}
  />
));
Separator.displayName = 'Separator';

// ------------------------------------------------------------------- Skeleton
/** Placeholder block. Uses a slow opacity shimmer (no sweeping gradient). */
function Skeleton({ className, ...props }: DivProps) {
  return (
    <div aria-hidden className={cn('animate-shimmer rounded-sm bg-muted', className)} {...props} />
  );
}

// ------------------------------------------------------------------------ Kbd
function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded-xs border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Badge,
  badgeVariants,
  Separator,
  Skeleton,
  Kbd,
};
