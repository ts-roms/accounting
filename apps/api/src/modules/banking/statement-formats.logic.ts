/**
 * Bank statement file formats (pure): SWIFT MT940, ISO 20022 camt.053 and
 * OFX / QFX, the exports most banks offer next to CSV. Each parser turns a
 * file into the shape `POST /bank-statements` imports - opening / closing
 * balance, statement date and signed lines - so a file from any of these
 * connectors goes through the same matching engine as a pasted CSV. Nothing
 * here touches the ledger; a person still reviews and imports.
 */

export type StatementFormat = 'MT940' | 'CAMT053' | 'OFX';

export interface ParsedStatementLine {
  lineDate: string;
  description: string;
  reference?: string;
  /** Signed: positive = money in, negative = money out. Decimal string. */
  amount: string;
  balance?: string;
}

export interface ParsedStatement {
  format: StatementFormat;
  /** Account identifier as written in the file (IBAN, account number), for the reviewer to check. */
  accountRef: string | null;
  currency: string | null;
  statementDate: string;
  openingBalance: string;
  closingBalance: string;
  lines: ParsedStatementLine[];
  warnings: string[];
}

export class StatementFormatError extends Error {}

/** Which parser a file wants, from its content (the extension is not trusted). */
export function detectStatementFormat(text: string): StatementFormat | null {
  const head = text.slice(0, 4000);
  if (
    /<\s*(?:\w+:)?Document\b[^>]*camt\.053/i.test(head) ||
    /<\s*(?:\w+:)?BkToCstmrStmt\b/i.test(head)
  )
    return 'CAMT053';
  if (/<OFX>|OFXHEADER|<STMTTRN>/i.test(head)) return 'OFX';
  if (/^:20:|\n:20:|:60F:|:61:/m.test(head)) return 'MT940';
  return null;
}

export function parseStatementFile(text: string): ParsedStatement {
  const format = detectStatementFormat(text);
  if (format === 'MT940') return parseMt940(text);
  if (format === 'CAMT053') return parseCamt053(text);
  if (format === 'OFX') return parseOfx(text);
  throw new StatementFormatError(
    'Unrecognised statement file: expected MT940 (:20:/:61: tags), camt.053 XML or OFX.',
  );
}

// ---------------------------------------------------------------- helpers

/** Fixed-point decimal arithmetic on strings (4 dp) without floats. */
const SCALE = 10_000n;
function toUnits(v: string): bigint {
  const s = v.trim().replace(',', '.');
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new StatementFormatError(`Bad amount "${v}"`);
  const whole = m[2] || '0';
  const frac = (m[3] ?? '').padEnd(4, '0').slice(0, 4);
  const units = BigInt(whole) * SCALE + BigInt(frac);
  return m[1] === '-' ? -units : units;
}
function fromUnits(u: bigint): string {
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(4, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
const add = (a: string, b: string) => fromUnits(toUnits(a) + toUnits(b));
const signed = (amount: string, credit: boolean) =>
  fromUnits(credit ? toUnits(amount) : -toUnits(amount));

const isoFromYYMMDD = (s: string, warnings: string[]): string => {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) {
    warnings.push(`Unreadable date "${s}"`);
    return '1970-01-01';
  }
  const yy = Number(m[1]);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${year}-${m[2]}-${m[3]}`;
};
const isoFromYYYYMMDD = (s: string): string | null => {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- MT940

interface Mt940Balance {
  credit: boolean;
  date: string;
  currency: string;
  amount: string;
}

function mt940Balance(raw: string, warnings: string[]): Mt940Balance {
  // [C|D]YYMMDDCCYamount,dd
  const m = /^([CD])(\d{6})([A-Z]{3})([\d,.]+)/.exec(raw.trim());
  if (!m) throw new StatementFormatError(`Bad MT940 balance "${raw}"`);
  return {
    credit: m[1] === 'C',
    date: isoFromYYMMDD(m[2]!, warnings),
    currency: m[3]!,
    amount: m[4]!.replace(',', '.'),
  };
}

export function parseMt940(text: string): ParsedStatement {
  const warnings: string[] = [];
  // Tags start a line with :NN: or :NNa:; continuation lines belong to the previous tag.
  const fields: Array<{ tag: string; value: string }> = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) fields.push({ tag: m[1]!, value: m[2]! });
    else if (fields.length && line.trim() !== '-' && line.trim() !== '')
      fields[fields.length - 1]!.value += '\n' + line;
  }
  if (!fields.some((f) => f.tag === '61' || f.tag === '60F' || f.tag === '60M'))
    throw new StatementFormatError('MT940 file has no :60F: opening balance and no :61: lines.');

  let accountRef: string | null = null;
  let opening: Mt940Balance | null = null;
  let closing: Mt940Balance | null = null;
  const lines: ParsedStatementLine[] = [];
  let pending: ParsedStatementLine | null = null;
  const flush = () => {
    if (pending) lines.push(pending);
    pending = null;
  };
  for (const f of fields) {
    switch (f.tag) {
      case '25':
        accountRef = clean(f.value);
        break;
      case '60F':
      case '60M':
        if (!opening) opening = mt940Balance(f.value, warnings);
        break;
      case '62F':
      case '62M':
        closing = mt940Balance(f.value, warnings);
        break;
      case '61': {
        flush();
        // YYMMDD[MMDD](C|D|RC|RD)[funds code]amount[N]type//bank ref [\n supplementary]
        const m = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?([\d,.]+)([A-Z][A-Z0-9]{3})?([^\n]*)/.exec(
          f.value.trim(),
        );
        if (!m) {
          warnings.push(`Skipped unreadable :61: line "${clean(f.value).slice(0, 40)}"`);
          break;
        }
        const credit = m[3] === 'C' || m[3] === 'RD';
        const rest = m[7] ?? '';
        const [ownRef, bankRef] = rest.split('//');
        pending = {
          lineDate: isoFromYYMMDD(m[1]!, warnings),
          description: clean(ownRef ?? '') || 'Statement line',
          reference: clean(bankRef ?? '') || undefined,
          amount: signed(m[5]!.replace(',', '.'), credit),
        };
        break;
      }
      case '86':
        if (pending) {
          const info = clean(f.value.replace(/\?\d{2}/g, ' '));
          if (info) pending.description = info.slice(0, 300);
        }
        break;
      default:
        break;
    }
  }
  flush();
  if (!opening) throw new StatementFormatError('MT940 file has no :60F: opening balance.');
  const openingBalance = signed(opening.amount, opening.credit);
  const computed = lines.reduce((acc, l) => add(acc, l.amount), openingBalance);
  const closingBalance = closing ? signed(closing.amount, closing.credit) : computed;
  if (!closing) warnings.push('No :62F: closing balance; computed from the lines.');
  else if (toUnits(closingBalance) !== toUnits(computed))
    warnings.push(`Lines sum to ${computed}, the file's closing balance is ${closingBalance}.`);
  const currency = opening.currency;
  return {
    format: 'MT940',
    accountRef,
    currency,
    statementDate: closing?.date ?? lines.at(-1)?.lineDate ?? opening.date,
    openingBalance,
    closingBalance,
    lines,
    warnings,
  };
}

// ---------------------------------------------------------------- camt.053

/** First text of <tag>…</tag> inside a fragment, namespace prefixes ignored. */
function xmlText(fragment: string, tag: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${tag}>`, 'i').exec(
    fragment,
  );
  return m ? decodeXml(m[1]!.trim()) : null;
}
function xmlBlocks(fragment: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out.push(m[1]!);
  return out;
}
function xmlAttr(fragment: string, tag: string, attr: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\s[^>]*\\b${attr}="([^"]*)"`, 'i').exec(fragment);
  return m ? m[1]! : null;
}
const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export function parseCamt053(text: string): ParsedStatement {
  const warnings: string[] = [];
  const statements = xmlBlocks(text, 'Stmt');
  if (statements.length === 0)
    throw new StatementFormatError('camt.053 file has no <Stmt> element.');
  if (statements.length > 1)
    warnings.push(`File holds ${statements.length} statements; only the first was read.`);
  const stmt = statements[0]!;
  const acct = xmlBlocks(stmt, 'Acct')[0] ?? '';
  const accountRef = xmlText(acct, 'IBAN') ?? xmlText(acct, 'Id') ?? null;
  let currency = xmlText(acct, 'Ccy');

  let openingBalance: string | null = null;
  let closingBalance: string | null = null;
  let statementDate: string | null = null;
  for (const bal of xmlBlocks(stmt, 'Bal')) {
    const code = xmlText(bal, 'Cd');
    const amt = xmlText(bal, 'Amt');
    if (!amt) continue;
    currency ??= xmlAttr(bal, 'Amt', 'Ccy');
    const value = signed(amt, xmlText(bal, 'CdtDbtInd') === 'CRDT');
    const date = xmlText(bal, 'Dt') ?? xmlText(bal, 'DtTm')?.slice(0, 10) ?? null;
    if (code === 'OPBD' || (code === 'PRCD' && openingBalance === null)) openingBalance = value;
    if (code === 'CLBD' || code === 'CLAV') {
      closingBalance = value;
      statementDate = date ?? statementDate;
    }
  }
  const lines: ParsedStatementLine[] = [];
  for (const entry of xmlBlocks(stmt, 'Ntry')) {
    const amt = xmlText(entry, 'Amt');
    if (!amt) continue;
    const credit = xmlText(entry, 'CdtDbtInd') === 'CRDT';
    const reversal = xmlText(entry, 'RvslInd') === 'true';
    const booking = xmlBlocks(entry, 'BookgDt')[0];
    const valueDate = xmlBlocks(entry, 'ValDt')[0];
    const date =
      (booking && (xmlText(booking, 'Dt') ?? xmlText(booking, 'DtTm')?.slice(0, 10))) ??
      (valueDate && (xmlText(valueDate, 'Dt') ?? xmlText(valueDate, 'DtTm')?.slice(0, 10))) ??
      null;
    if (!date) {
      warnings.push('Skipped an entry without a booking or value date.');
      continue;
    }
    const details = xmlBlocks(entry, 'TxDtls')[0] ?? '';
    const description =
      xmlText(details, 'Ustrd') ??
      xmlText(entry, 'AddtlNtryInf') ??
      xmlText(details, 'Nm') ??
      'Statement entry';
    const reference =
      xmlText(entry, 'AcctSvcrRef') ??
      xmlText(details, 'EndToEndId') ??
      xmlText(details, 'TxId') ??
      undefined;
    lines.push({
      lineDate: date,
      description: clean(description).slice(0, 300),
      reference: reference ? clean(reference).slice(0, 100) : undefined,
      amount: signed(amt, reversal ? !credit : credit),
    });
  }
  if (openingBalance === null && closingBalance === null)
    throw new StatementFormatError('camt.053 statement has no OPBD / CLBD balances.');
  const sum = lines.reduce((acc, l) => add(acc, l.amount), '0');
  if (openingBalance === null) {
    openingBalance = fromUnits(toUnits(closingBalance!) - toUnits(sum));
    warnings.push('No opening balance (OPBD); computed from the closing balance and the lines.');
  }
  if (closingBalance === null) {
    closingBalance = add(openingBalance, sum);
    warnings.push('No closing balance (CLBD); computed from the lines.');
  } else if (toUnits(closingBalance) !== toUnits(add(openingBalance, sum)))
    warnings.push(
      `Lines sum to ${add(openingBalance, sum)}, the file's closing balance is ${closingBalance}.`,
    );
  return {
    format: 'CAMT053',
    accountRef,
    currency,
    statementDate:
      statementDate ??
      xmlText(xmlBlocks(stmt, 'FrToDt')[0] ?? '', 'ToDtTm')?.slice(0, 10) ??
      lines.at(-1)?.lineDate ??
      xmlText(stmt, 'CreDtTm')?.slice(0, 10) ??
      '1970-01-01',
    openingBalance,
    closingBalance,
    lines,
    warnings,
  };
}

// ---------------------------------------------------------------- OFX

/** OFX 1.x is SGML (tags often unclosed), OFX 2.x is XML: read `<TAG>value` either way. */
function ofxValue(fragment: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(fragment);
  return m ? clean(decodeXml(m[1]!)) : null;
}

export function parseOfx(text: string): ParsedStatement {
  const warnings: string[] = [];
  const stmt = /<STMTRS>([\s\S]*?)(?:<\/STMTRS>|$)/i.exec(text)?.[1] ?? text;
  const currency = ofxValue(stmt, 'CURDEF');
  const acctFrom =
    /<BANKACCTFROM>([\s\S]*?)(?:<\/BANKACCTFROM>|<BANKTRANLIST>)/i.exec(stmt)?.[1] ?? '';
  const accountRef = ofxValue(acctFrom, 'ACCTID');
  const lines: ParsedStatementLine[] = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRN>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt))) {
    const block = m[1]!;
    const amount = ofxValue(block, 'TRNAMT');
    const posted = ofxValue(block, 'DTPOSTED');
    const date = posted ? isoFromYYYYMMDD(posted) : null;
    if (!amount || !date) {
      warnings.push('Skipped a transaction without amount or date.');
      continue;
    }
    const name = ofxValue(block, 'NAME');
    const memo = ofxValue(block, 'MEMO');
    const type = ofxValue(block, 'TRNTYPE');
    lines.push({
      lineDate: date,
      description: clean([name, memo].filter(Boolean).join(' - ') || type || 'Transaction').slice(
        0,
        300,
      ),
      reference: (ofxValue(block, 'CHECKNUM') ?? ofxValue(block, 'FITID') ?? undefined)?.slice(
        0,
        100,
      ),
      amount: fromUnits(toUnits(amount)),
    });
  }
  if (lines.length === 0) throw new StatementFormatError('OFX file has no <STMTTRN> transactions.');
  const ledger = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(stmt)?.[1] ?? '';
  const closingRaw = ofxValue(ledger, 'BALAMT');
  const sum = lines.reduce((acc, l) => add(acc, l.amount), '0');
  let closingBalance: string;
  if (closingRaw) closingBalance = fromUnits(toUnits(closingRaw));
  else {
    closingBalance = sum;
    warnings.push(
      'No <LEDGERBAL>; closing balance computed from the lines with an opening balance of 0.',
    );
  }
  const openingBalance = fromUnits(toUnits(closingBalance) - toUnits(sum));
  const asOf = ofxValue(ledger, 'DTASOF');
  const tranList = /<BANKTRANLIST>([\s\S]*?)<STMTTRN>/i.exec(stmt)?.[1] ?? '';
  const end = ofxValue(tranList, 'DTEND');
  return {
    format: 'OFX',
    accountRef,
    currency,
    statementDate:
      (asOf && isoFromYYYYMMDD(asOf)) ?? (end && isoFromYYYYMMDD(end)) ?? lines.at(-1)!.lineDate,
    openingBalance,
    closingBalance,
    lines,
    warnings,
  };
}
