import {
  buildMilestoneSchedule,
  buildRatableSchedule,
  buildSchedule,
  deferredBalance,
  inclusiveDays,
  resolveServiceWindow,
  waterfall,
} from './revenue.logic';

describe('revenue.logic', () => {
  it('prorates a ratable line by days across calendar months and keeps the total exact', () => {
    const lines = buildRatableSchedule('12000', 'PHP', '2026-05-15', '2026-08-14');
    expect(lines.map((l) => l.recognitionDate)).toEqual([
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-14',
    ]);
    // 17 + 30 + 31 + 14 = 92 days
    expect(inclusiveDays('2026-05-15', '2026-08-14')).toBe(92);
    const total = lines.reduce((sum, l) => sum + Number(l.amount), 0);
    expect(total.toFixed(4)).toBe('12000.0000');
    expect(lines[0]!.amount).toBe('2217.3914'); // 12000 * 17 / 92 (+ remainder minor unit)
    expect(lines[3]!.amount).toBe('1826.0869');
  });

  it('recognizes a single-month service in one line on the service end', () => {
    const lines = buildRatableSchedule('900', 'PHP', '2026-06-01', '2026-06-30');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ recognitionDate: '2026-06-30', amount: '900.0000' });
  });

  it('derives the service window from the policy term when the end is open', () => {
    expect(resolveServiceWindow({ documentDate: '2026-05-01', defaultTermMonths: 12 })).toEqual({
      start: '2026-05-01',
      end: '2027-04-30',
    });
    expect(() => resolveServiceWindow({ documentDate: '2026-05-01' })).toThrow(/service end/);
    expect(() =>
      resolveServiceWindow({
        documentDate: '2026-05-01',
        serviceStartDate: '2026-06-01',
        serviceEndDate: '2026-05-31',
      }),
    ).toThrow(/precedes/);
  });

  it('splits milestones by percent and refuses totals other than 100', () => {
    const lines = buildMilestoneSchedule('10000', 'PHP', [
      { name: 'Kick-off', percent: '33.33', expectedDate: '2026-06-15' },
      { name: 'Build', percent: '33.33', expectedDate: null },
      { name: 'Go-live', percent: '33.34' },
    ]);
    expect(lines.map((l) => l.amount)).toEqual(['3333.0000', '3333.0000', '3334.0000']);
    expect(lines[0]).toMatchObject({ milestoneName: 'Kick-off', recognitionDate: '2026-06-15' });
    expect(lines[1]!.recognitionDate).toBeNull();
    expect(() => buildMilestoneSchedule('10', 'PHP', [{ name: 'Half', percent: '50' }])).toThrow(
      /not 100/,
    );
    expect(() => buildMilestoneSchedule('10', 'PHP', [])).toThrow(/at least one/);
  });

  it('builds nothing for point-in-time lines', () => {
    expect(
      buildSchedule({
        method: 'POINT_IN_TIME',
        amount: '100',
        currency: 'PHP',
        documentDate: '2026-05-01',
      }).lines,
    ).toEqual([]);
  });

  it('buckets the waterfall by due month, overdue into the first month, undated as unscheduled', () => {
    const result = waterfall(
      [
        {
          recognitionDate: '2026-04-30',
          amount: '100',
          status: 'PENDING',
          completed: false,
          method: 'RATABLE',
        },
        {
          recognitionDate: '2026-06-30',
          amount: '200',
          status: 'PENDING',
          completed: false,
          method: 'RATABLE',
        },
        {
          recognitionDate: '2026-07-31',
          amount: '300',
          status: 'PENDING',
          completed: false,
          method: 'RATABLE',
        },
        {
          recognitionDate: '2027-01-31',
          amount: '400',
          status: 'PENDING',
          completed: false,
          method: 'RATABLE',
        },
        {
          recognitionDate: null,
          amount: '50',
          status: 'PENDING',
          completed: false,
          method: 'MILESTONE',
        },
        {
          recognitionDate: '2026-06-30',
          amount: '999',
          status: 'RECOGNIZED',
          completed: true,
          method: 'RATABLE',
        },
      ],
      'PHP',
      '2026-06-10',
      3,
    );
    expect(result.buckets).toEqual([
      { month: '2026-06', amount: '300.0000' },
      { month: '2026-07', amount: '300.0000' },
      { month: '2026-08', amount: '0.0000' },
    ]);
    expect(result.beyond).toBe('400.0000');
    expect(result.unscheduled).toBe('50.0000');
    expect(result.total).toBe('1050.0000');
    expect(
      deferredBalance(
        [
          {
            recognitionDate: null,
            amount: '5',
            status: 'PENDING',
            completed: false,
            method: 'MILESTONE',
          },
          {
            recognitionDate: null,
            amount: '7',
            status: 'RECOGNIZED',
            completed: true,
            method: 'MILESTONE',
          },
        ],
        'PHP',
      ).toString(),
    ).toBe('5.0000');
  });
});
