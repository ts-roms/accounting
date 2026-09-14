import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { AiDocumentKind, AiProvider } from '@accounting/types';
import { aiExtractedFieldsSchema } from '@accounting/validation';
import { AppConfigService } from '@/config/app-config.service';
import { extractFromText, type ExtractionResult } from './ai.logic';

export interface ProviderExtraction extends ExtractionResult {
  provider: AiProvider;
  model: string | null;
}

export interface AnswerFacts {
  question: string;
  facts: { label: string; value: string }[];
  periodLabel: string;
  currency: string;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 25_000;

/**
 * Model backend behind every AI feature. HEURISTIC is the deterministic
 * baseline (regexes, history statistics) and is always the fallback; ANTHROPIC
 * adds vision extraction and natural phrasing. Neither writes to the ledger:
 * outputs are validated with the same Zod schemas a person's input would be.
 */
@Injectable()
export class AiProviderService {
  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiProviderService.name);
  }

  get name(): AiProvider {
    return this.config.env.AI_PROVIDER === 'ANTHROPIC' && this.config.env.ANTHROPIC_API_KEY
      ? 'ANTHROPIC'
      : 'HEURISTIC';
  }

  get model(): string | null {
    return this.name === 'ANTHROPIC' ? this.config.env.AI_MODEL : null;
  }

  /** Header fields + lines from text and/or an image; the heuristic result is the floor. */
  async extract(
    text: string | null,
    image: { mimeType: string; buffer: Buffer } | null,
  ): Promise<ProviderExtraction> {
    const baseline: ProviderExtraction = {
      ...(text ? extractFromText(text) : { kind: 'UNKNOWN', fields: { lines: [] }, confidence: 0 }),
      provider: 'HEURISTIC',
      model: null,
    };
    if (this.name !== 'ANTHROPIC' || (!text && !image)) return baseline;
    try {
      const content: unknown[] = [];
      if (image)
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mimeType,
            data: image.buffer.toString('base64'),
          },
        });
      content.push({
        type: 'text',
        text: `Extract the header and line items of this supplier invoice, bill or receipt. Reply with JSON only, no prose, using exactly this shape:
{"kind":"BILL|EXPENSE_CLAIM|UNKNOWN","confidence":0..1,"vendorName":string|null,"vendorTaxId":string|null,"documentDate":"YYYY-MM-DD"|null,"dueDate":"YYYY-MM-DD"|null,"reference":string|null,"currency":"PHP"|"USD"|...|null,"subtotal":"0.00"|null,"taxAmount":"0.00"|null,"total":"0.00"|null,"lines":[{"description":string,"quantity":"1","unitPrice":"0.00"}]}
Amounts are decimal strings without thousands separators. Use null when a field is not on the document.${text ? `\n\nDocument text:\n${text.slice(0, 12_000)}` : ''}`,
      });
      const json = await this.messages(content, 1500);
      const parsed = JSON.parse(stripFences(json)) as Record<string, unknown>;
      const fields = aiExtractedFieldsSchema.parse({
        vendorName: parsed.vendorName ?? undefined,
        vendorTaxId: parsed.vendorTaxId ?? undefined,
        documentDate: parsed.documentDate ?? null,
        dueDate: parsed.dueDate ?? null,
        reference: parsed.reference ?? undefined,
        currency: parsed.currency ?? null,
        subtotal: parsed.subtotal ?? null,
        taxAmount: parsed.taxAmount ?? null,
        total: parsed.total ?? null,
        lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      });
      const kind = (['BILL', 'EXPENSE_CLAIM', 'UNKNOWN'] as const).includes(
        parsed.kind as AiDocumentKind,
      )
        ? (parsed.kind as AiDocumentKind)
        : baseline.kind;
      const confidence =
        typeof parsed.confidence === 'number'
          ? Math.min(1, Math.max(0, parsed.confidence))
          : baseline.confidence;
      // Keep whichever side found more: a model that returns nothing must not erase the regex result.
      const merged = {
        ...baseline.fields,
        ...Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined && v !== null),
        ),
        lines: fields.lines.length ? fields.lines : baseline.fields.lines,
      };
      return {
        kind,
        fields: merged,
        confidence: Math.max(confidence, baseline.confidence),
        provider: 'ANTHROPIC',
        model: this.model,
      };
    } catch (err) {
      this.logger.warn({ err }, 'Model extraction failed; using heuristic extraction');
      return baseline;
    }
  }

  /** Turns verified facts into a short narrative; null means "use the template answer". */
  async phrase(input: AnswerFacts): Promise<{ text: string; model: string } | null> {
    if (this.name !== 'ANTHROPIC') return null;
    try {
      const text = await this.messages(
        [
          {
            type: 'text',
            text: `You are a finance assistant. Answer the user's question in at most three sentences using ONLY the facts below (they come from the posted general ledger). Do not invent numbers, do not give investment or legal advice, and say so if the facts do not answer the question. Amounts are in ${input.currency}.

Question: ${input.question}
Period: ${input.periodLabel}
Facts:
${input.facts.map((f) => `- ${f.label}: ${f.value}`).join('\n')}`,
          },
        ],
        400,
      );
      return { text: text.trim(), model: this.model! };
    } catch (err) {
      this.logger.warn({ err }, 'Model phrasing failed; using template answer');
      return null;
    }
  }

  private async messages(content: unknown[], maxTokens: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.env.AI_MODEL,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content }],
        }),
      });
      if (!res.ok)
        throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (body.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
    } finally {
      clearTimeout(timer);
    }
  }
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  return fence ? fence[1]!.trim() : trimmed;
}
