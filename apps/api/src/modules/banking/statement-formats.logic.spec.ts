import {
  detectStatementFormat,
  parseCamt053,
  parseMt940,
  parseOfx,
  parseStatementFile,
} from './statement-formats.logic';

const MT940 = `:20:STMT20260915
:25:BDO/001234567890
:28C:00042/001
:60F:C260901PHP125000,00
:61:2609020902C5000,00NTRFDEP-1//BDO1001
:86:?20DEPOSIT FROM CUSTOMER?21ALPHA CORP
:61:2609070907D350,00NCHGFEE//BDO1002
:86:SERVICE FEE
:61:2609120912RC1200,00NTRF//BDO1003
:86:REVERSAL OF DUPLICATE DEPOSIT
:62F:C260915PHP128450,00
-`;

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-09-16T01:00:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>S1</Id>
      <Acct><Id><IBAN>PH12BDO0000001234567890</IBAN></Id><Ccy>PHP</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="PHP">125000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="PHP">129650.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-15</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="PHP">5000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-09-02</Dt></BookgDt><ValDt><Dt>2026-09-02</Dt></ValDt>
        <AcctSvcrRef>BDO1001</AcctSvcrRef>
        <NtryDtls><TxDtls><Refs><EndToEndId>DEP-1</EndToEndId></Refs><RmtInf><Ustrd>Deposit from Alpha Corp</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="PHP">350.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>2026-09-07</Dt></BookgDt>
        <AddtlNtryInf>Service fee &amp; charges</AddtlNtryInf>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM><BANKID>021000021<ACCTID>987654321<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260901<DTEND>20260915
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260902120000<TRNAMT>1500.00<FITID>F1<NAME>WIRE IN<MEMO>Invoice 44</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910<TRNAMT>-42.50<FITID>F2<CHECKNUM>1001<NAME>BANK FEE</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2457.50<DTASOF>20260915</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe('statement file formats', () => {
  it('detects the format from content, not the extension', () => {
    expect(detectStatementFormat(MT940)).toBe('MT940');
    expect(detectStatementFormat(CAMT)).toBe('CAMT053');
    expect(detectStatementFormat(OFX)).toBe('OFX');
    expect(detectStatementFormat('date,description,amount\n2026-09-01,x,1')).toBeNull();
    expect(() => parseStatementFile('hello')).toThrow(/Unrecognised/);
  });

  it('parses MT940: signed lines, :86: narratives, reversals and the closing balance check', () => {
    const s = parseMt940(MT940);
    expect(s.format).toBe('MT940');
    expect(s.accountRef).toBe('BDO/001234567890');
    expect(s.currency).toBe('PHP');
    expect(s.statementDate).toBe('2026-09-15');
    expect(s.openingBalance).toBe('125000.0000');
    expect(s.closingBalance).toBe('128450.0000');
    expect(s.lines).toEqual([
      {
        lineDate: '2026-09-02',
        description: 'DEPOSIT FROM CUSTOMER ALPHA CORP',
        reference: 'BDO1001',
        amount: '5000.0000',
      },
      {
        lineDate: '2026-09-07',
        description: 'SERVICE FEE',
        reference: 'BDO1002',
        amount: '-350.0000',
      },
      // RC = reversal of a credit: money out.
      {
        lineDate: '2026-09-12',
        description: 'REVERSAL OF DUPLICATE DEPOSIT',
        reference: 'BDO1003',
        amount: '-1200.0000',
      },
    ]);
    // 125000 + 5000 - 350 - 1200 = 128450: consistent, no warning.
    expect(s.warnings).toEqual([]);
  });

  it('parses camt.053: OPBD / CLBD, entries with remittance info, XML entities', () => {
    const s = parseCamt053(CAMT);
    expect(s.format).toBe('CAMT053');
    expect(s.accountRef).toBe('PH12BDO0000001234567890');
    expect(s.currency).toBe('PHP');
    expect(s.statementDate).toBe('2026-09-15');
    expect(s.openingBalance).toBe('125000.0000');
    expect(s.closingBalance).toBe('129650.0000');
    expect(s.lines).toEqual([
      {
        lineDate: '2026-09-02',
        description: 'Deposit from Alpha Corp',
        reference: 'BDO1001',
        amount: '5000.0000',
      },
      {
        lineDate: '2026-09-07',
        description: 'Service fee & charges',
        reference: undefined,
        amount: '-350.0000',
      },
    ]);
    expect(s.warnings).toEqual([]);
  });

  it('parses OFX (SGML): transactions, ledger balance as closing, opening derived', () => {
    const s = parseOfx(OFX);
    expect(s.format).toBe('OFX');
    expect(s.accountRef).toBe('987654321');
    expect(s.currency).toBe('USD');
    expect(s.statementDate).toBe('2026-09-15');
    expect(s.closingBalance).toBe('2457.5000');
    expect(s.openingBalance).toBe('1000.0000');
    expect(s.lines).toEqual([
      {
        lineDate: '2026-09-02',
        description: 'WIRE IN - Invoice 44',
        reference: 'F1',
        amount: '1500.0000',
      },
      { lineDate: '2026-09-10', description: 'BANK FEE', reference: '1001', amount: '-42.5000' },
    ]);
  });

  it('warns when the file closing balance disagrees with the lines', () => {
    const s = parseMt940(MT940.replace(':62F:C260915PHP128450,00', ':62F:C260915PHP128000,00'));
    expect(s.closingBalance).toBe('128000.0000');
    expect(s.warnings[0]).toMatch(/Lines sum to 128450.0000/);
  });
});
