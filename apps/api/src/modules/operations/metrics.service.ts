import { Injectable } from '@nestjs/common';

/**
 * Minimal in-process Prometheus registry (hardening H8): request counters and
 * latency histograms per route, job-run counters, plus gauges computed at
 * scrape time. Kept dependency-free on purpose; the exposition format is the
 * text format every scraper understands.
 */

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Labels = Record<string, string | number>;

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();
  private readonly gauges = new Map<
    string,
    () => Promise<Array<{ labels: Labels; value: number }>>
  >();
  private readonly help = new Map<string, string>();

  constructor() {
    this.help.set('http_requests_total', 'HTTP requests by method, route and status class');
    this.help.set('http_request_duration_seconds', 'HTTP request latency');
    this.help.set('job_runs_total', 'Background job executions by job and outcome');
    this.help.set('process_uptime_seconds', 'Seconds since the API instance started');
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    let series = this.counters.get(name);
    if (!series) {
      series = new Map();
      this.counters.set(name, series);
    }
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + by);
  }

  observe(name: string, labels: Labels, seconds: number): void {
    let series = this.histograms.get(name);
    if (!series) {
      series = new Map();
      this.histograms.set(name, series);
    }
    const key = labelKey(labels);
    let h = series.get(key);
    if (!h) {
      h = { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 };
      series.set(key, h);
    }
    // Store per-bin counts; rendering accumulates them into Prometheus' cumulative buckets.
    const bin = LATENCY_BUCKETS.findIndex((le) => seconds <= le);
    if (bin >= 0) h.buckets[bin]! += 1;
    h.sum += seconds;
    h.count += 1;
  }

  /** Gauge whose values are computed on every scrape (queue depths, pool sizes...). */
  registerGauge(
    name: string,
    help: string,
    collect: () => Promise<Array<{ labels: Labels; value: number }>>,
  ): void {
    this.help.set(name, help);
    this.gauges.set(name, collect);
  }

  /** Prometheus text exposition (version 0.0.4). */
  async render(): Promise<string> {
    const out: string[] = [];
    const header = (name: string, type: string) => {
      out.push(`# HELP ${name} ${this.help.get(name) ?? name}`);
      out.push(`# TYPE ${name} ${type}`);
    };
    for (const [name, series] of this.counters) {
      header(name, 'counter');
      for (const [labels, value] of series) out.push(`${name}{${labels}} ${value}`);
    }
    for (const [name, series] of this.histograms) {
      header(name, 'histogram');
      for (const [labels, h] of series) {
        let cumulative = 0;
        LATENCY_BUCKETS.forEach((le, i) => {
          cumulative += h.buckets[i]!;
          out.push(`${name}_bucket{${labels}${labels ? ',' : ''}le="${le}"} ${cumulative}`);
        });
        out.push(`${name}_bucket{${labels}${labels ? ',' : ''}le="+Inf"} ${h.count}`);
        out.push(`${name}_sum{${labels}} ${h.sum.toFixed(6)}`);
        out.push(`${name}_count{${labels}} ${h.count}`);
      }
    }
    header('process_uptime_seconds', 'gauge');
    out.push(`process_uptime_seconds ${Math.round(process.uptime())}`);
    for (const [name, collect] of this.gauges) {
      header(name, 'gauge');
      try {
        for (const { labels, value } of await collect())
          out.push(`${name}{${labelKey(labels)}} ${value}`);
      } catch {
        // A failing collector must not break the scrape of everything else.
      }
    }
    return `${out.join('\n')}\n`;
  }
}
