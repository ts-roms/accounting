import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('renders counters, histograms and gauges in the Prometheus text format', async () => {
    const m = new MetricsService();
    m.increment('http_requests_total', { method: 'GET', route: '/a', status: '2xx' });
    m.increment('http_requests_total', { method: 'GET', route: '/a', status: '2xx' });
    m.increment('http_requests_total', { method: 'POST', route: '/b', status: '5xx' });
    m.observe('http_request_duration_seconds', { method: 'GET', route: '/a' }, 0.02);
    m.observe('http_request_duration_seconds', { method: 'GET', route: '/a' }, 3);
    m.registerGauge('queue_jobs', 'Jobs per queue', async () => [
      { labels: { queue: 'maintenance', state: 'failed' }, value: 4 },
    ]);
    const text = await m.render();
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain('http_requests_total{method="GET",route="/a",status="2xx"} 2');
    expect(text).toContain('http_requests_total{method="POST",route="/b",status="5xx"} 1');
    // Cumulative buckets: 0.02 falls in le=0.025 and above; 3 only in le=5, 10 and +Inf.
    expect(text).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/a",le="0.01"} 0',
    );
    expect(text).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/a",le="0.025"} 1',
    );
    expect(text).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/a",le="5"} 2',
    );
    expect(text).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/a",le="+Inf"} 2',
    );
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/a"} 2');
    expect(text).toContain('http_request_duration_seconds_sum{method="GET",route="/a"} 3.020000');
    expect(text).toContain('queue_jobs{queue="maintenance",state="failed"} 4');
    expect(text).toMatch(/process_uptime_seconds \d+/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes label values and survives a failing gauge collector', async () => {
    const m = new MetricsService();
    m.increment('http_requests_total', { method: 'GET', route: '/say/"hi"\\there', status: '2xx' });
    m.registerGauge('broken', 'boom', async () => {
      throw new Error('boom');
    });
    const text = await m.render();
    expect(text).toContain('route="/say/\\"hi\\"\\\\there"');
    expect(text).toContain('# TYPE broken gauge');
  });
});
