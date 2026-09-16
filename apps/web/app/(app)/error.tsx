'use client';
import * as React from 'react';
import { ErrorState } from '@accounting/ui';

/**
 * Route-level error boundary. Shows the standard error state with a reference
 * (Next's digest) and timestamp; never the stack trace.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [at] = React.useState(() => new Date());
  React.useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <ErrorState
      title="Something went wrong on this page"
      description="The page failed to render. Retry, or return to the dashboard if the problem persists."
      reference={error.digest}
      timestamp={at}
      onRetry={reset}
    />
  );
}
