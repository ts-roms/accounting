import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import type { PostingLine } from './posting.service';

/**
 * Foreign-amount fields for a document line that hits `account`.
 *
 * A base-currency account takes a document in any currency (the base amount is
 * what it books). An account bound to a foreign currency only takes documents
 * in that currency and its line carries the document amount in it, so the
 * account's foreign balance is always derivable from the ledger.
 */
export function foreignLineFields(
  account: { code: string; name: string; currency: string | null },
  baseCurrency: string,
  document: { currency: string; amount: string; exchangeRate: string },
  side: 'debit' | 'credit',
): Pick<PostingLine, 'foreignDebit' | 'foreignCredit' | 'foreignCurrency' | 'exchangeRate'> {
  if (!account.currency || account.currency === baseCurrency) return {};
  assertAccountTakesCurrency(account, baseCurrency, document.currency);
  return {
    foreignDebit: side === 'debit' ? document.amount : '0',
    foreignCredit: side === 'credit' ? document.amount : '0',
    foreignCurrency: account.currency,
    exchangeRate: document.exchangeRate,
  };
}

/** Refuses a document in `currency` on an account bound to a different foreign currency. */
export function assertAccountTakesCurrency(
  account: { code: string; name: string; currency: string | null },
  baseCurrency: string,
  currency: string,
): void {
  if (account.currency && account.currency !== baseCurrency && account.currency !== currency)
    throw new BusinessRuleError(
      ErrorCodes.CURRENCY_MISMATCH,
      `${account.code} ${account.name} is a ${account.currency} account; it cannot take a ${currency} document.`,
      { accountCurrency: account.currency, currency },
    );
}
