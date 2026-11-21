import type { EconomicClient } from './client.js';
import { EconomicHttpError } from '../errors.js';
import { callEndpoint } from './endpoints.js';
import { loadPolicy } from './policy.js';
import { prepareOperation, type PreparedOperation } from './operations.js';

export const MAX_BOOKING_ENTRIES = 25;

/** The most draft entries the gateway's book_journal books in one call (a whole journal). */
export const MAX_JOURNAL_BOOKING_ENTRIES = 100;

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
  date?: string;
  amount?: number;
  text?: string;
  journalNumber?: number;
  accountNumber?: number;
  journal?: { journalNumber?: number };
  voucher?: { voucherNumber?: number };
  account?: { accountNumber?: number };
}

/**
 * Hard cap on draft-entry pages read before booking. Reaching it with a
 * cursor left refuses the booking: a partial list could book only part of a
 * voucher, or miss that an entry belongs to another journal.
 */
export const MAX_DRAFT_PAGES = 200;

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
  const requireVoucher = input.requireVoucher ?? true;
  const validation = await validateBooking(client, {
    journalNumber: input.journalNumber,
    entryNumbers: input.entryNumbers,
    requireVoucher,
  });

  const operation = prepareOperation({
    capability: 'economic_prepare_booking',
    serviceId: 'journals',
    method: 'POST',
    pathTemplate: '/journals/{journalNumber}/bookdraftentries',
    pathParams: { journalNumber: validation.journalNumber },
    body: { entryNumbers: validation.entries.map(entry => entry.entryNumber) },
    reason: input.reason,
    bookingGuards: { requireVoucher },
  });

  return {
    operation,
    validation,
    note: 'BOOKING IS IRREVERSIBLE. Review the validated entries with the user, then execute with economic_commit_booking (not the ordinary commit tool). Corrections after booking require reversing entries or credit notes.',
  };
}

/**
 * Booking guardrails, run both when preparing and again right before commit
 * (entries can change, and policy can tighten, in between): every requested
 * entry must exist in the journal, per-entry amounts must pass the policy
 * maxAmount check, and every referenced voucher must have an attached
 * document unless explicitly waived.
 */
export async function validateBooking(
  client: EconomicClient,
  input: { journalNumber: number; entryNumbers: number[]; requireVoucher: boolean },
  /**
   * Where the per-entry amount limit comes from. Omitted: the standalone
   * server's policy (loadPolicy, which reads ECONOMIC_* settings). The embedded
   * gateway passes its own value and never reads the environment.
   */
  limits?: { maxAmount?: number; maxEntries?: number },
): Promise<BookingValidation> {
  const maxEntries = limits?.maxEntries ?? MAX_BOOKING_ENTRIES;
  if (!Number.isInteger(input.journalNumber) || input.journalNumber < 1) {
    throw new Error('journalNumber must be a positive integer.');
  }
  if (!Array.isArray(input.entryNumbers) || !input.entryNumbers.every(isPositiveInteger)) {
    throw new Error('entryNumbers must be positive integers.');
  }
  const entryNumbers = [...new Set(input.entryNumbers)];
  if (entryNumbers.length === 0 || entryNumbers.length > maxEntries) {
    throw new Error(`entryNumbers must contain 1-${maxEntries} unique draft entry numbers.`);
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

  const maxAmount = limits ? limits.maxAmount : loadPolicy().maxAmount;
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

  if (maxAmount !== undefined) {
    const over = entries.filter(
      entry => typeof entry.amount === 'number' && Math.abs(entry.amount) > maxAmount,
    );
    if (over.length > 0) {
      throw new Error(
        `Booking blocked: entries exceed policy maxAmount ${maxAmount}: ${over
          .map(entry => `${entry.entryNumber} (${entry.amount})`)
          .join(', ')}`,
      );
    }
  }

  const vouchers = [...new Set(entries.map(entry => entry.voucherNumber).filter(isNumber))];
  if (input.requireVoucher) {
    if (vouchers.length === 0) {
      throw new Error(
        'Booking blocked: no voucher numbers on the requested entries. Pass requireVoucher=false only if documentation is verified elsewhere.',
      );
    }
    // A voucher is a voucher number in an accounting year: the same number can
    // be used again in another year, so each (number, year) pair is checked.
    const years = await accountingYears(client);
    const pairs = new Map<string, { voucherNumber: number; accountingYear: string | undefined }>();
    for (const draft of wanted.values()) {
      const voucherNumber = draft.voucherNumber ?? draft.voucher?.voucherNumber;
      if (!isNumber(voucherNumber)) continue;
      const accountingYear = yearOf(years, typeof draft.date === 'string' ? draft.date.slice(0, 10) : undefined);
      pairs.set(`${voucherNumber}|${accountingYear ?? ''}`, { voucherNumber, accountingYear });
    }
    for (const { voucherNumber, accountingYear } of pairs.values()) {
      await assertVoucherHasAttachment(client, voucherNumber, accountingYear);
    }
  }

  return {
    journalNumber: input.journalNumber,
    entries,
    totalAbsoluteAmount: entries.reduce(
      (sum, entry) => sum + Math.abs(typeof entry.amount === 'number' ? entry.amount : 0),
      0,
    ),
    vouchersChecked: input.requireVoucher ? vouchers : [],
  };
}

/**
 * Commit-time re-validation of a (signature-verified) booking or match
 * operation. The operation's shape is checked strictly and every booking
 * guardrail runs again against current data and the current policy.
 */
export async function revalidateBookingOperation(
  client: EconomicClient,
  operation: PreparedOperation,
): Promise<void> {
  if (operation.query !== undefined && Object.keys(operation.query).length > 0) {
    throw new Error('Booking operations take no query parameters.');
  }
  const body = operation.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Booking operation body must be an object.');
  }
  const keys = Object.keys(body);

  if (operation.capability === 'economic_prepare_booking') {
    if (
      operation.serviceId !== 'journals' ||
      operation.method !== 'POST' ||
      operation.pathTemplate !== '/journals/{journalNumber}/bookdraftentries'
    ) {
      throw new Error('Booking operation targets an unexpected endpoint.');
    }
    const params = operation.pathParams ?? {};
    const journal = String(params.journalNumber ?? '');
    if (Object.keys(params).length !== 1 || !/^[1-9][0-9]*$/.test(journal)) {
      throw new Error('Booking operation journalNumber must be a positive integer (digits only).');
    }
    const entryNumbers = (body as { entryNumbers?: unknown }).entryNumbers;
    if (keys.length !== 1 || keys[0] !== 'entryNumbers' || !Array.isArray(entryNumbers)) {
      throw new Error('Booking operation body must contain only entryNumbers.');
    }
    const requireVoucher = operation.bookingGuards?.requireVoucher ?? true;
    if (typeof requireVoucher !== 'boolean') {
      throw new Error('Booking operation has an invalid requireVoucher guard.');
    }
    await validateBooking(client, {
      journalNumber: Number(journal),
      entryNumbers: entryNumbers as number[],
      requireVoucher,
    });
    return;
  }

  if (operation.capability === 'economic_prepare_open_item_match') {
    if (
      operation.serviceId !== 'booked-entries' ||
      operation.method !== 'POST' ||
      operation.pathTemplate !== '/booked-entries/match' ||
      (operation.pathParams !== undefined && Object.keys(operation.pathParams).length > 0)
    ) {
      throw new Error('Open-item match operation targets an unexpected endpoint.');
    }
    const entryIds = (body as { entryIds?: unknown }).entryIds;
    if (keys.length !== 1 || keys[0] !== 'entryIds' || !Array.isArray(entryIds)) {
      throw new Error('Open-item match body must contain only entryIds.');
    }
    assertMatchEntryIds(entryIds);
    return;
  }

  throw new Error(`Not a booking capability: ${operation.capability}`);
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
  assertMatchEntryIds(entryIds);

  return prepareOperation({
    capability: 'economic_prepare_open_item_match',
    serviceId: 'booked-entries',
    method: 'POST',
    pathTemplate: '/booked-entries/match',
    body: { entryIds },
    reason: input.reason,
  });
}

/**
 * The draft entry numbers of the given vouchers in one journal, for booking a
 * whole voucher (all its lines) at once. Throws when a voucher has no draft
 * entries in that journal (already booked, deleted, or another journal).
 */
export async function draftEntryNumbersForVouchers(
  client: EconomicClient,
  journalNumber: number,
  voucherNumbers: number[],
): Promise<number[]> {
  if (!Number.isInteger(journalNumber) || journalNumber < 1) {
    throw new Error('journalNumber must be a positive integer.');
  }
  const wanted = [...new Set(voucherNumbers)];
  if (wanted.length === 0 || !wanted.every(isPositiveInteger)) {
    throw new Error('voucherNumbers must be positive integers.');
  }
  const drafts = await fetchDraftEntries(client);
  const found = new Map<number, number[]>();
  for (const draft of drafts) {
    const voucher = draft.voucherNumber ?? draft.voucher?.voucherNumber;
    const journal = draft.journalNumber ?? draft.journal?.journalNumber;
    if (voucher === undefined || draft.entryNumber === undefined || journal !== journalNumber) continue;
    if (!wanted.includes(voucher)) continue;
    found.set(voucher, [...(found.get(voucher) ?? []), draft.entryNumber]);
  }
  const missing = wanted.filter(voucher => !found.has(voucher));
  if (missing.length > 0) {
    throw new Error(
      `No draft entries in journal ${journalNumber} for voucher(s) ${missing.join(', ')} (already booked, deleted, or another journal?).`,
    );
  }
  return wanted.flatMap(voucher => found.get(voucher) ?? []);
}

/**
 * The draft entry numbers of one journal, read from the full list of draft
 * entries (never from a partial list: fetchDraftEntries throws instead).
 */
export async function draftEntryNumbersOfJournal(client: EconomicClient, journalNumber: number): Promise<number[]> {
  if (!Number.isInteger(journalNumber) || journalNumber < 1) {
    throw new Error('journalNumber must be a positive integer.');
  }
  const drafts = await fetchDraftEntries(client);
  const numbers: number[] = [];
  for (const draft of drafts) {
    const journal = draft.journalNumber ?? draft.journal?.journalNumber;
    if (journal === journalNumber && draft.entryNumber !== undefined) numbers.push(draft.entryNumber);
  }
  return [...new Set(numbers)];
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
    if (response.cursor === cursor) {
      throw new Error('Booking blocked: e-conomic returned the same draft-entry page cursor twice.');
    }
    cursor = response.cursor;
  }

  // Never book from a partial list of draft entries.
  throw new Error(
    `Booking blocked: the draft entries did not fit in ${MAX_DRAFT_PAGES} pages, so the full list could not be read. Book the entries in e-conomic, or empty the journal of old drafts first.`,
  );
}

interface AccountingYearRange {
  year: string;
  fromDate: string;
  toDate: string;
}

/** The accounting years with their dates (classic REST GET /accounting-years). */
async function accountingYears(client: EconomicClient): Promise<AccountingYearRange[]> {
  const response = (await callEndpoint(client, {
    serviceId: 'rest',
    method: 'GET',
    pathTemplate: '/accounting-years',
    query: { pagesize: 1000 },
  })) as { collection?: Array<{ year?: unknown; fromDate?: unknown; toDate?: unknown }> };
  return (Array.isArray(response?.collection) ? response.collection : []).flatMap(item =>
    typeof item.year === 'string' && typeof item.fromDate === 'string' && typeof item.toDate === 'string'
      ? [{ year: item.year, fromDate: item.fromDate.slice(0, 10), toDate: item.toDate.slice(0, 10) }]
      : [],
  );
}

/** The accounting year that holds the date, or undefined. */
function yearOf(years: AccountingYearRange[], date: string | undefined): string | undefined {
  return date ? years.find(year => year.fromDate <= date && date <= year.toDate)?.year : undefined;
}

/**
 * The voucher has an attached document in its accounting year: documentsapi
 * lists attached documents by voucher number and year (GET /AttachedDocuments
 * with a filter). `/AttachedDocuments/{number}` takes the document's own
 * number, not the voucher's, so it cannot answer this.
 */
async function assertVoucherHasAttachment(
  client: EconomicClient,
  voucherNumber: number,
  accountingYear: string | undefined,
): Promise<void> {
  const blocked = (why: string, cause?: unknown) =>
    new Error(
      `Booking blocked: voucher ${voucherNumber} has no verifiable attached document (${why}). Attach the document first, or pass requireVoucher=false if documentation is verified elsewhere.`,
      // An HTTP error of e-conomic's as the cause keeps its status and request id for the result's failure metadata.
      cause === undefined ? undefined : { cause },
    );
  if (!accountingYear) {
    throw blocked('the accounting year of its entries could not be determined');
  }
  let response: unknown;
  try {
    response = await callEndpoint(client, {
      serviceId: 'documents',
      method: 'GET',
      pathTemplate: '/AttachedDocuments',
      query: { filter: `voucherNumber$eq:${voucherNumber}$and:accountingYear$eq:${accountingYear}` },
    });
  } catch (error) {
    // A refused access (401) goes on as e-conomic's own error, so an embedding host can tell that it was taken back.
    if (error instanceof EconomicHttpError && error.status === 401) throw error;
    throw blocked(error instanceof Error ? error.message : String(error), error);
  }
  const items = Array.isArray(response)
    ? response
    : Array.isArray((response as { items?: unknown })?.items)
      ? (response as { items: unknown[] }).items
      : [];
  const attached = items.some(item => {
    const document = item as { voucherNumber?: unknown; accountingYear?: unknown };
    return document.voucherNumber === voucherNumber && document.accountingYear === accountingYear;
  });
  if (!attached) {
    throw blocked(`none found for voucher ${voucherNumber} in ${accountingYear}`);
  }
}

export function assertMatchEntryIds(entryIds: unknown[]): void {
  if (
    entryIds.length < 2 ||
    entryIds.length > 100 ||
    !entryIds.every(isPositiveInteger) ||
    new Set(entryIds).size !== entryIds.length
  ) {
    throw new Error('entryIds must contain 2-100 unique booked entry numbers (same customer or supplier ledger).');
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
