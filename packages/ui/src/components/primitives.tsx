'use client';
/* Small, stateless primitives grouped in one module: Label, Card, Badge, Separator, Skeleton. */
import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

// ---------------------------------------------------------------------- Label
const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  />
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

const Card = div('Card', 'rounded-lg border bg-card text-card-foreground shadow-sm');
const CardHeader = div('CardHeader', 'flex flex-col space-y-1 p-4');
const CardTitle = div('CardTitle', 'text-sm font-semibold leading-none tracking-tight');
const CardDescription = div('CardDescription', 'text-xs text-muted-foreground');
const CardContent = div('CardContent', 'p-4 pt-0');
const CardFooter = div('CardFooter', 'flex items-center p-4 pt-0');

// ---------------------------------------------------------------------- Badge
const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive/10 text-destructive',
        success: 'border-transparent bg-success/10 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
        outline: 'text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends DivProps, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

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
function Skeleton({ className, ...props }: DivProps) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
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
};
