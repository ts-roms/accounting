'use client';
import * as React from 'react';
import Link from 'next/link';
import { MessageSquareText, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import { Button, Card, CardContent, Skeleton, Textarea } from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useAiAsk, useAiConversation, useAiConversations } from '@/lib/api/ai-hooks';
import type { AiMessage } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { EmptyState, PageHeader } from '@/components/ui-ext/page';
import { AdvisoryNote } from './shared';

const SUGGESTIONS = [
  'What was our revenue last month?',
  'Are we profitable this year?',
  'How much cash do we have?',
  'Which customers owe us the most?',
  'What are the top expenses this quarter?',
  'Any open anomaly flags?',
  'Forecast revenue for the next 3 months',
];

export function AiAssistantPage() {
  const { hasPermission } = useSession();
  const canAsk = hasPermission(P['ai.use']);
  const conversations = useAiConversations();
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const conversation = useAiConversation(conversationId);
  const ask = useAiAsk();
  const [question, setQuestion] = React.useState('');
  /** Messages shown before the query refetches (keeps the exchange snappy). */
  const [pending, setPending] = React.useState<AiMessage[]>([]);
  const bottom = React.useRef<HTMLDivElement>(null);
  const messages = [
    ...(conversation.data?.messages ?? []),
    ...pending.filter((m) => !conversation.data?.messages.some((x) => x.id === m.id)),
  ];
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const submit = async (text = question) => {
    const q = text.trim();
    if (!q || ask.isPending) return;
    setQuestion('');
    try {
      const r = await ask.mutateAsync({ question: q, conversationId: conversationId ?? undefined });
      setPending((p) => [...p, r.question, r.answer]);
      setConversationId(r.conversationId);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Ask the assistant"
        description="Questions about your posted numbers, answered from the same reports you see - with the sources listed."
      />
      <AdvisoryNote />
      <div className="grid gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-1">
          <CardContent className="space-y-2 p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                setConversationId(null);
                setPending([]);
              }}
              data-testid="assistant-new"
            >
              <MessageSquareText /> New conversation
            </Button>
            <div className="max-h-[60vh] space-y-1 overflow-y-auto">
              {conversations.data?.items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted ${c.id === conversationId ? 'bg-muted font-medium' : ''}`}
                  onClick={() => {
                    setConversationId(c.id);
                    setPending([]);
                  }}
                  title={c.title}
                >
                  {c.title}
                </button>
              ))}
              {conversations.data && conversations.data.items.length === 0 ? (
                <p className="px-2 text-xs text-muted-foreground">No conversations yet.</p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardContent className="flex h-[70vh] flex-col p-0">
            <div className="flex-1 space-y-4 overflow-y-auto p-4" data-testid="assistant-thread">
              {conversationId && conversation.isLoading ? <Skeleton className="h-24" /> : null}
              {messages.length === 0 && !conversation.isLoading ? (
                <EmptyState
                  title="Ask something"
                  description="Try one of these, or type your own question below."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      {SUGGESTIONS.map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant="outline"
                          disabled={!canAsk}
                          onClick={() => submit(s)}
                        >
                          {s}
                        </Button>
                      ))}
                    </div>
                  }
                />
              ) : null}
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {ask.isPending ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Sparkles className="h-4 w-4 animate-pulse" /> Looking at the ledger...
                </div>
              ) : null}
              <div ref={bottom} />
            </div>
            <form
              className="flex items-end gap-2 border-t p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <Textarea
                rows={2}
                value={question}
                disabled={!canAsk}
                placeholder={
                  canAsk
                    ? 'e.g. What did we spend on office supplies in Q2?'
                    : 'You can read conversations but not ask (needs ai.use).'
                }
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                data-testid="assistant-input"
              />
              <Button
                type="submit"
                disabled={!canAsk || !question.trim() || ask.isPending}
                data-testid="assistant-send"
              >
                <Send /> Ask
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function MessageBubble({ message }: { message: AiMessage }) {
  const mine = message.role === 'USER';
  return (
    <div
      className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
      data-testid={mine ? 'assistant-question' : 'assistant-answer'}
    >
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${mine ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
        {!mine && message.sources.length ? (
          <ul className="mt-2 space-y-0.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
            {message.sources.map((s, i) => (
              <li key={i}>
                {s.href ? (
                  <Link href={s.href} className="underline">
                    {s.label}
                  </Link>
                ) : (
                  s.label
                )}
                : <span className="tabular">{s.value}</span>{' '}
                <span className="opacity-70">({s.report})</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div
          className={`mt-1 text-[10px] ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
        >
          {formatDateTime(message.createdAt)}
          {!mine && message.provider
            ? ` · ${message.provider === 'ANTHROPIC' ? message.model : 'heuristics'}`
            : ''}
        </div>
      </div>
    </div>
  );
}
