import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import path from 'node:path';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';

export interface OcrResult {
  text: string;
  /** Mean word confidence 0..1 as reported by the engine. */
  confidence: number;
  provider: 'TESSERACT';
}

type Worker = {
  recognize: (image: Buffer) => Promise<{ data: { text: string; confidence: number } }>;
  terminate: () => Promise<unknown>;
};

/**
 * OCR fallback for scanned images (Phase 9 follow-up). When no model backend
 * is configured, an uploaded photo or scan of a receipt used to land in
 * NEEDS_REVIEW with nothing extracted; with `OCR_PROVIDER=TESSERACT` the text
 * is read locally by tesseract.js (WASM, no system binary, no network at
 * recognition time) and handed to the same heuristic extractor that reads
 * text uploads. Language data is downloaded once into `OCR_CACHE_DIR` (or
 * read from `OCR_LANG_PATH` for air-gapped hosts). Advisory like the rest of
 * the module: the result is a suggestion a person reviews, never a posting.
 */
@Injectable()
export class OcrService implements OnModuleDestroy {
  private worker: Promise<Worker> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OcrService.name);
  }

  get enabled(): boolean {
    return this.config.env.OCR_PROVIDER === 'TESSERACT';
  }

  get name(): 'TESSERACT' | null {
    return this.enabled ? 'TESSERACT' : null;
  }

  /** Text of an image, or null when OCR is off, the engine fails or finds nothing. */
  async recognize(image: Buffer): Promise<OcrResult | null> {
    if (!this.enabled) return null;
    const timeoutMs = this.config.env.OCR_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const worker = await this.getWorker();
      const result = await Promise.race([
        worker.recognize(image),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`OCR timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]);
      const text = result.data.text?.trim() ?? '';
      if (!text) return null;
      return {
        text,
        confidence: Math.min(1, Math.max(0, (result.data.confidence ?? 0) / 100)),
        provider: 'TESSERACT',
      };
    } catch (err) {
      this.logger.warn({ err }, 'OCR failed; the upload continues without text');
      // A wedged worker is not reused.
      const stale = this.worker;
      this.worker = null;
      void stale?.then((w) => w.terminate()).catch(() => undefined);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private getWorker(): Promise<Worker> {
    if (!this.worker) {
      this.worker = (async () => {
        // Loaded lazily: the WASM engine is only paid for when OCR is on.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const tesseract = require('tesseract.js') as {
          createWorker: (
            langs: string,
            oem: number,
            options: Record<string, unknown>,
          ) => Promise<Worker>;
          OEM: { LSTM_ONLY: number };
        };
        const env = this.config.env;
        const cachePath = env.OCR_CACHE_DIR ?? path.join(env.STORAGE_DIR, 'ocr-cache');
        const started = Date.now();
        const worker = await tesseract.createWorker(env.OCR_LANGUAGES, tesseract.OEM.LSTM_ONLY, {
          cachePath,
          ...(env.OCR_LANG_PATH ? { langPath: env.OCR_LANG_PATH, gzip: false } : {}),
          logger: () => undefined,
          errorHandler: (err: unknown) => this.logger.warn({ err }, 'OCR worker error'),
        });
        this.logger.info(
          { languages: env.OCR_LANGUAGES, cachePath, ms: Date.now() - started },
          'OCR worker ready',
        );
        return worker;
      })();
      this.worker.catch(() => {
        this.worker = null;
      });
    }
    return this.worker;
  }

  async onModuleDestroy(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.then((w) => w.terminate()).catch(() => undefined);
  }
}
