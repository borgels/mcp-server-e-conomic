import type { EconomicClient } from './client.js';
import { callEndpoint } from './endpoints.js';
import { loadPolicy } from './policy.js';
import { prepareOperation, type PreparedOperation } from './operations.js';

export const MAX_BOOKING_ENTRIES = 25;

export const BOOKING_CAPABILITIES = new Set([
  'economic_prepare_booking',
  'economic_prepare_open_item_match',
]);

export interface PrepareBookingInput {
  journalNumber: number;
  entryNumbers: number[];
  reason: string;
  /**
   * Require every voucher referenced by the entries to have an attached
   * document before booking can be prepared. Set false only when the human
   * has verified the documentation exists elsewhere.
   */
  requireVoucher?: boolean;
}

export interface BookingValidation {
  journalNumber: number;
  entries: Array<{
    entryNumber: number;
    voucherNumber?: number;
    amount?: number;
    text?: string;
    accountNumber?: number;
  }>;
  totalAbsoluteAmount: number;
  vouchersChecked: number[];
}

export interface PreparedBooking {
  operation: PreparedOperation;
  validation: BookingValidation;
  note: string;
}

interface DraftEntry {
  entryNumber?: number;
  voucherNumber?: number;
  amount?: number;
  text?: string;
  journalNumber?: number;
  accountNumber?: number;
  journal?: { journalNumber?: number };
  voucher?: { voucherNumber?: number };
  account?: { accountNumber?: number };
}

const MAX_DRAFT_PAGES = 10;

/**
 * Prepares booking of EXPLICIT draft entries (journalsapi
 * POST /journals/{n}/bookdraftentries). Booking is irreversible, so the
 * preparation enforces guardrails beyond the normal write policy:
 * every requested entry must exist in the journal, per-entry amounts run
 * through the policy maxAmount check, and every referenced voucher must have
 * an attached document (unless explicitly waived). The returned operation is
 * executed with economic_commit_booking — never the ordinary commit tool.
 */
export async function prepareBooking(
  client: EconomicClient,
  input: PrepareBookingInput,
): Promise<PreparedBooking> {
  if (!Number.isInteger(input.journalNumber) || input.journalNumber < 1) {
    throw new Error('journalNumber must be a positive integer.');
  }
  const entryNumbers = [...new Set(input.entryNumbers)];
  if (entryNumbers.length === 0 || entryNumbers.length > MAX_BOOKING_ENTRIES) {
    throw new Error(`entryNumbers must contain 1-${MAX_BOOKING_ENTRIES} unique draft entry numbers.`);
  }

  const drafts = await fetchDraftEntries(client);
  const wanted = new Map<number, DraftEntry>();
  for (const draft of drafts) {
    const entryNumber = draft.entryNumber;
    const journal = draft.journalNumber ?? draft.journal?.journalNumber;
    if (entryNumber !== undefined && entryNumbers.includes(entryNumber)) {
      if (journal !== undefined && journal !== input.journalNumber) {
        throw new Error(
          `Draft entry ${entryNumber} belongs to journal ${journal}, not ${input.journalNumber}.`,
        );
      }
      wanted.set(entryNumber, draft);
    }
  }

  const missing = entryNumbers.filter(number => !wanted.has(number));
  if (missing.length > 0) {
    throw new Error(
      `Draft entries not found (already booked, deleted, or wrong journal?): ${missing.join(', ')}`,
    );
  }

  const policy = loadPolicy();
  const entries = entryNumbers.map(number => {
    const draft = wanted.get(number) as DraftEntry;
    return {
      entryNumber: number,
      voucherNumber: draft.voucherNumber ?? draft.voucher?.voucherNumber,
      amount: draft.amount,
      text: draft.text,
      accountNumber: draft.accountNumber ?? draft.account?.accountNumber,
    };
  });

  if (policy.maxAmount !== undefined) {
    const over = entries.filter(
      entry => typeof entry.amount === 'number' && Math.abs(entry.amount) > (policy.maxAmount as number),
    );
    if (over.length > 0) {
      throw new Error(
        `Booking blocked: entries exceed policy maxAmount ${policy.maxAmount}: ${over
          .map(entry => `${entry.entryNumber} (${entry.amount})`)
          .join(', ')}`,
      );
    }
  }

  const requireVoucher = input.requireVoucher ?? true;
  const vouchers = [...new Set(entries.map(entry => entry.voucherNumber).filter(isNumber))];
  if (requireVoucher) {
    if (vouchers.length === 0) {
      throw new Error(
        'Booking blocked: no voucher numbers on the requested entries. Pass requireVoucher=false only if documentation is verified elsewhere.',
      );
    }
    for (const voucherNumber of vouchers) {
      await assertVoucherHasAttachment(client, voucherNumber);
    }
  }

  const operation = prepareOperation({
    capability: 'economic_prepare_booking',
    serviceId: 'journals',
    method: 'POST',
    pathTemplate: '/journals/{journalNumber}/bookdraftentries',
    pathParams: { journalNumber: input.journalNumber },
    body: { entryNumbers },
    reason: input.reason,
  });

  return {
    operation,
    validation: {
      journalNumber: input.journalNumber,
      entries,
      totalAbsoluteAmount: entries.reduce(
        (sum, entry) => sum + Math.abs(typeof entry.amount === 'number' ? entry.amount : 0),
        0,
      ),
      vouchersChecked: requireVoucher ? vouchers : [],
    },
    note: 'BOOKING IS IRREVERSIBLE. Review the validated entries with the user, then execute with economic_commit_booking (not the ordinary commit tool). Corrections after booking require reversing entries or credit notes.',
  };
}

export interface PrepareOpenItemMatchInput {
  entryIds: number[];
  reason: string;
}

/**
 * Prepares open-item matching (udligning) of booked customer/supplier
 * entries (bookedentriesapi POST /booked-entries/match). e-conomic has no
 * API to undo a match, so this runs at the booking duty level and executes
 * only via economic_commit_booking.
 */
export function prepareOpenItemMatch(input: PrepareOpenItemMatchInput): PreparedOperation {
  const entryIds = [...new Set(input.entryIds)];
  if (entryIds.length < 2 || entryIds.length > 100) {
    throw new Error('entryIds must contain 2-100 unique booked entry numbers (same customer or supplier ledger).');
  }

  return prepareOperation({
    capability: 'economic_prepare_open_item_match',
    serviceId: 'booked-entries',
    method: 'POST',
    pathTemplate: '/booked-entries/match',
    body: { entryIds },
    reason: input.reason,
  });
}

async function fetchDraftEntries(client: EconomicClient): Promise<DraftEntry[]> {
  const all: DraftEntry[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_DRAFT_PAGES; page += 1) {
    const response = (await callEndpoint(client, {
      serviceId: 'journals',
      method: 'GET',
      pathTemplate: '/draft-entries',
      query: cursor ? { cursor } : undefined,
    })) as { cursor?: string | null; items?: DraftEntry[] };

    all.push(...(response.items ?? []));
    if (!response.cursor) {
      return all;
    }
    cursor = response.cursor;
  }

  return all;
}

async function assertVoucherHasAttachment(client: EconomicClient, voucherNumber: number): Promise<void> {
  try {
    await callEndpoint(client, {
      serviceId: 'documents',
      method: 'GET',
      pathTemplate: '/AttachedDocuments/{number}',
      pathParams: { number: voucherNumber },
    });
  } catch (error) {
    throw new Error(
      `Booking blocked: voucher ${voucherNumber} has no verifiable attached document (${
        error instanceof Error ? error.message : String(error)
      }). Attach the document first, or pass requireVoucher=false if documentation is verified elsewhere.`,
    );
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
