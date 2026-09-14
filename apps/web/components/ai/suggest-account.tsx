'use client';
import * as React from 'react';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { P, type AiClassifySide } from '@accounting/types';
import { Button } from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useAiClassify } from '@/lib/api/ai-hooks';
import type { AiAccountSuggestion } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';

/**
 * "Suggest" button next to an account picker: asks the classifier for the
 * account (and tax code) the company usually posts this description to. The
 * person still picks - the button only fills the field.
 */
export function SuggestAccountButton({
  description,
  side,
  partyId,
  onSuggest,
  disabled,
}: {
  description: string;
  side: AiClassifySide;
  partyId?: string | null;
  onSuggest: (s: AiAccountSuggestion) => void;
  disabled?: boolean;
}) {
  const { hasPermission } = useSession();
  const classify = useAiClassify();
  if (!hasPermission(P['ai.use'])) return null;
  const run = async () => {
    try {
      const [best] = await classify.mutateAsync({
        description,
        side,
        partyId: partyId || undefined,
        limit: 1,
      });
      if (!best) {
        toast.info('No suggestion - nothing similar has been posted yet.');
        return;
      }
      onSuggest(best);
      toast.success(
        `Suggested ${best.accountCode} ${best.accountName} (${Math.round(best.confidence * 100)}%: ${best.rationale}).`,
      );
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-8 w-8 shrink-0"
      title="Suggest an account from posting history"
      aria-label="Suggest account"
      disabled={disabled || classify.isPending || description.trim().length < 2}
      onClick={run}
      data-testid="suggest-account"
    >
      <Sparkles className={classify.isPending ? 'animate-pulse' : ''} />
    </Button>
  );
}
