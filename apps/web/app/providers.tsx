'use client';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AlertTriangle, Check, CircleAlert, Info, Loader2 } from 'lucide-react';
import { ThemeProvider, TooltipProvider, useTheme } from '@accounting/ui';
import { ApiError } from '@/lib/api/client';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300} skipDelayDuration={200}>
          {children}
        </TooltipProvider>
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

/**
 * Toasts: short confirmations only (saved / posted / synced). Icons carry the
 * tone so colour is never the sole signal; styling comes from the tokens.
 */
function ThemedToaster() {
  const { resolved } = useTheme();
  return (
    <Toaster
      position="top-right"
      theme={resolved}
      closeButton
      duration={4000}
      gap={8}
      offset={16}
      icons={{
        success: <Check className="size-4 text-positive" strokeWidth={2.5} />,
        error: <CircleAlert className="size-4 text-critical" />,
        warning: <AlertTriangle className="size-4 text-warning" />,
        info: <Info className="size-4 text-info" />,
        loading: <Loader2 className="size-4 animate-spin text-muted-foreground" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'group flex w-[356px] items-start gap-3 rounded-md border border-border bg-popover p-3.5 text-sm text-popover-foreground shadow-lg',
          title: 'font-medium leading-5',
          description: 'text-xs text-muted-foreground leading-4 mt-0.5',
          icon: 'mt-0.5 shrink-0',
          closeButton:
            '!static !order-last !ml-auto !size-5 !translate-x-0 !translate-y-0 !rounded-sm !border-0 !bg-transparent !text-muted-foreground hover:!bg-accent hover:!text-foreground',
          actionButton:
            'rounded-sm bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground',
          cancelButton: 'rounded-sm bg-secondary px-2.5 py-1 text-xs font-medium',
        },
      }}
    />
  );
}
