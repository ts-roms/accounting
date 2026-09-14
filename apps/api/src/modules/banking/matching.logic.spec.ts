import { Money } from '@accounting/money';
import { matchStatementLines, reconciliationDifference } from './matching.logic';

const PHP = 'PHP';
const cand = (id: string, date: string, debit: string, credit: string, reference: string | null = null) => ({ journalLineId: id, entryDate: date, debit, credit, reference, description: null });

describe('bank matching', () => {
  it('matches single amount/date hits, flags ambiguity, duplicates and unmatched lines', () => {
    const lines = [
      { id: 's1', lineDate: '2026-09-02', amount: '5000.0000', reference: 'DEP-1', description: 'Deposit' },
      { id: 's2', lineDate: '2026-09-03', amount: '-1200.0000', reference: null, description: 'Check 101' },
      { id: 's3', lineDate: '2026-09-03', amount: '-1200.0000', reference: null, description: 'Check 101' },
      { id: 's4', lineDate: '2026-09-05', amount: '-350.0000', reference: null, description: 'Bank fee' },
      { id: 's5', lineDate: '2026-09-06', amount: '-800.0000', reference: 'CHK-202', description: 'Check 202' },
    ];
    const candidates = [
      cand('j1', '2026-09-01', '5000', '0'),
      cand('j2', '2026-09-03', '0', '1200'),
      cand('j3', '2026-09-06', '0', '800', 'CHK-201'),
      cand('j4', '2026-09-06', '0', '800', 'CHK-202'),
    ];
    const out = matchStatementLines(lines, candidates, PHP, 3);
    expect(out.find((o) => o.statementLineId === 's1')).toMatchObject({ status: 'MATCHED', journalLineId: 'j1' });
    expect(out.find((o) => o.statementLineId === 's2')).toMatchObject({ status: 'MATCHED', journalLineId: 'j2' });
    expect(out.find((o) => o.statementLineId === 's3')).toMatchObject({ status: 'DUPLICATE' });
    expect(out.find((o) => o.statementLineId === 's4')).toMatchObject({ status: 'UNMATCHED' });
    expect(out.find((o) => o.statementLineId === 's5')).toMatchObject({ status: 'MATCHED', journalLineId: 'j4' });
  });

  it('several candidates without a reference tie-break is an exception; the date window is enforced', () => {
    const lines = [{ id: 's1', lineDate: '2026-09-10', amount: '-800.0000', reference: null, description: 'x' }];
    const both = matchStatementLines(lines, [cand('a', '2026-09-10', '0', '800'), cand('b', '2026-09-11', '0', '800')], PHP, 3);
    expect(both[0]).toMatchObject({ status: 'EXCEPTION', candidates: ['a', 'b'] });
    const late = matchStatementLines(lines, [cand('a', '2026-09-01', '0', '800')], PHP, 3);
    expect(late[0]!.status).toBe('UNMATCHED');
  });

  it('reconciliation difference is zero when every item is explained', () => {
    const m = (v: string) => Money.of(v, PHP);
    expect(
      reconciliationDifference({ statementBalance: m('10000'), ledgerBalance: m('9650'), depositsInTransit: m('500'), outstandingPayments: m('1200'), unrecordedCredits: m('0'), unrecordedDebits: m('350') })
        .toString(),
    ).toBe('0.0000');
    expect(
      reconciliationDifference({ statementBalance: m('10000'), ledgerBalance: m('9650'), depositsInTransit: m('0'), outstandingPayments: m('0'), unrecordedCredits: m('0'), unrecordedDebits: m('0') }).toString(),
    ).toBe('350.0000');
  });
});
