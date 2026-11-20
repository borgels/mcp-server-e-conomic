// Attached documents (bilag) and PDFs in ./gateway (#65).
import { describe, expect, it } from 'vitest';
import {
  createEconomicGateway,
  economicToolCatalog,
  resolveEconomicChange,
  resolveEconomicReadTarget,
  type GatewayJsonObject,
} from '../src/gateway.js';

const context = { credentials: { agreementGrantToken: 'grant-token-for-tests' } };
const PDF = Buffer.from('%PDF-1.7\n% test\n').toString('base64');

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  contentType: string | null;
  text: string;
}

function fakeEconomic(answer: (request: Request) => Response | undefined = () => undefined, enableWrites = true) {
  const requests: Seen[] = [];
  const gateway = createEconomicGateway({
    appSecretToken: 'app-secret-for-tests',
    policy: { enableWrites, allowBooking: enableWrites },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = request.method === 'GET' ? '' : Buffer.from(await request.clone().arrayBuffer()).toString('latin1');
      requests.push({ method: request.method, path: url.pathname, query: url.searchParams, contentType: request.headers.get('content-type'), text });
      return answer(request) ?? Response.json({ number: 6001, voucherNumber: 501, accountingYear: '2026' }, { status: 201 });
    }) as typeof fetch,
  });
  return { gateway, requests };
}

describe('attach_voucher_file', () => {
  it('posts the file as multipart to documentsapi, refusing a second document by default', async () => {
    const { gateway, requests } = fakeEconomic();
    const result = await gateway.callTool('attach_voucher_file', {
      accountingYear: '2026',
      voucherNumber: 501,
      contentType: 'application/pdf',
      fileBase64: PDF,
    }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]?.text.split('\n\n')[0]).toBe('Attached a PDF to voucher 501 in 2026.');
    expect(requests).toHaveLength(1);
    const [post] = requests;
    expect(post).toMatchObject({ method: 'POST', path: '/documentsapi/v4.0.2/AttachedDocuments' });
    expect(post!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(post!.text).toContain('name="VoucherNumber"\r\n\r\n501\r\n');
    expect(post!.text).toContain('name="AccountingYear"\r\n\r\n2026\r\n');
    expect(post!.text).toContain('name="OnConflict"\r\n\r\nFail\r\n');
    expect(post!.text).toContain('name="File"; filename="bilag-501.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7');
  });

  it('merges only when asked', async () => {
    const { gateway, requests } = fakeEconomic();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const result = await gateway.callTool('attach_voucher_file', {
      accountingYear: '2025/2026', voucherNumber: 7, contentType: 'image/png', fileBase64: png, onConflict: 'merge',
    }, context);
    expect(result.isError).toBeUndefined();
    expect(requests[0]!.text).toContain('name="OnConflict"\r\n\r\nMerge\r\n');
    expect(requests[0]!.text).toContain('filename="bilag-7.png"');
  });

  it('refuses a file that is not what it says, not base64, or too large, and sends nothing', async () => {
    const { gateway, requests } = fakeEconomic();
    const cases: GatewayJsonObject[] = [
      { accountingYear: '2026', voucherNumber: 1, contentType: 'image/jpeg', fileBase64: PDF },
      { accountingYear: '2026', voucherNumber: 1, contentType: 'application/pdf', fileBase64: 'not base64!' },
      { accountingYear: '2026', voucherNumber: 1, contentType: 'application/pdf', fileBase64: 'A'.repeat(12_600_000) },
      { accountingYear: '26', voucherNumber: 1, contentType: 'application/pdf', fileBase64: PDF },
      { accountingYear: '2026', voucherNumber: 0, contentType: 'application/pdf', fileBase64: PDF },
      { accountingYear: '2026', voucherNumber: 1, contentType: 'text/html', fileBase64: PDF },
      { accountingYear: '2026', voucherNumber: 1, contentType: 'application/pdf', fileBase64: PDF, onConflict: 'replace' },
    ];
    for (const input of cases) {
      const result = await gateway.callTool('attach_voucher_file', input, context);
      expect(result.isError, JSON.stringify(input).slice(0, 120)).toBe(true);
    }
    expect(requests).toEqual([]);
  });

  it('is refused when writes are off', async () => {
    const { gateway, requests } = fakeEconomic(undefined, false);
    const result = await gateway.callTool('attach_voucher_file', {
      accountingYear: '2026', voucherNumber: 1, contentType: 'application/pdf', fileBase64: PDF,
    }, context);
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });

  it('logs the voucher, the year and the type, never the file', () => {
    const resolved = resolveEconomicChange('attach_voucher_file', {
      accountingYear: '2026', voucherNumber: 501, contentType: 'application/pdf', fileBase64: PDF,
    });
    expect(resolved).toEqual({
      ok: true,
      change: {
        tool: 'attach_voucher_file',
        action: 'create',
        record: 'attached-document',
        booking: false,
        values: { voucherNumber: 501, accountingYear: '2026', contentType: 'application/pdf' },
      },
    });
  });

  it('offers no deletion of attached documents', () => {
    const tool = economicToolCatalog.find(entry => entry.name === 'attach_voucher_file')!;
    expect(tool.upstream).toEqual([
      { access: 'write', method: 'POST', path: '/documentsapi/v4.0.2/AttachedDocuments', serviceId: 'documents', resource: 'AttachedDocuments' },
    ]);
    for (const entry of economicToolCatalog) {
      expect(entry.upstream.some(operation => /delete/i.test(operation.path)), entry.name).toBe(false);
    }
  });
});

describe('get_document', () => {
  function pdfAnswer(size: number) {
    return (request: Request) =>
      new URL(request.url).pathname.endsWith('/pdf')
        ? new Response(new Uint8Array(size).fill(0x25), { headers: { 'content-type': 'application/pdf' } })
        : Response.json([{ number: 6001, voucherNumber: 501, accountingYear: '2026' }]);
  }

  it('lists attached documents by default', async () => {
    const { gateway, requests } = fakeEconomic(pdfAnswer(10));
    const result = await gateway.callTool('get_document', {}, context);
    expect(result.isError).toBeUndefined();
    expect(requests[0]!.path).toBe('/documentsapi/v4.0.2/AttachedDocuments/paged');
  });

  it('returns the PDF of an attached document, a booked invoice or a draft invoice as base64', async () => {
    const { gateway, requests } = fakeEconomic(pdfAnswer(2048));
    for (const [input, path] of [
      [{ number: 6001, pdf: true }, '/documentsapi/v4.0.2/AttachedDocuments/6001/pdf'],
      [{ resource: 'invoices/booked', number: 70001, pdf: true }, '/invoices/booked/70001/pdf'],
      [{ resource: 'invoices/drafts', number: 7, pdf: true }, '/invoices/drafts/7/pdf'],
    ] as Array<[GatewayJsonObject, string]>) {
      const result = await gateway.callTool('get_document', input, context);
      expect(result.isError, result.content[0]?.text).toBeUndefined();
      expect(result.structuredContent).toEqual({
        contentType: 'application/pdf',
        sizeBytes: 2048,
        base64: Buffer.from(new Uint8Array(2048).fill(0x25)).toString('base64'),
      });
      expect(result.content[0]?.text.split('\n\n')[0]).toMatch(/^get_document: PDF of one record from .+ \(2 KB\)\.$/);
      expect(requests.at(-1)!.path).toBe(path);
    }
  });

  it('refuses a PDF larger than 4 MB', async () => {
    const { gateway } = fakeEconomic(pdfAnswer(4 * 1024 * 1024 + 1));
    const result = await gateway.callTool('get_document', { number: 6001, pdf: true }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('larger than 4 MB');
  });

  it('needs a number for a PDF, and reads only its own targets', () => {
    expect(resolveEconomicReadTarget('get_document', { pdf: true }).ok).toBe(false);
    expect(resolveEconomicReadTarget('get_document', { resource: 'invoices/unpaid', number: 1, pdf: true }).ok).toBe(false);
    expect(resolveEconomicReadTarget('invoice_overview', { number: 1, pdf: true }).ok).toBe(false);
    expect(resolveEconomicReadTarget('get_document', { resource: 'invoices/booked', number: 3, pdf: true })).toEqual({
      ok: true,
      target: { serviceId: 'rest', resource: 'invoices/booked', method: 'GET', pathTemplate: '/invoices/booked/{number}/pdf', pathParams: { number: 3 } },
    });
  });
});

describe('the booking guard finds the voucher’s document by voucher number and year', () => {
  function journal(documents: unknown[]) {
    return (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/accounting-years') {
        return Response.json({
          collection: [
            { year: '2025', fromDate: '2025-01-01', toDate: '2025-12-31' },
            { year: '2026', fromDate: '2026-01-01', toDate: '2026-12-31' },
          ],
        });
      }
      if (url.pathname.endsWith('/draft-entries')) {
        return Response.json({ items: [{ entryNumber: 13, journalNumber: 1, voucherNumber: 502, date: '2026-03-02T00:00:00', amount: 99 }] });
      }
      if (url.pathname.endsWith('/AttachedDocuments')) return Response.json({ items: documents });
      if (url.pathname.endsWith('/bookdraftentries')) return Response.json({ ok: true });
      return undefined;
    };
  }

  it('books when the voucher has a document in the year of its entries', async () => {
    const { gateway, requests } = fakeEconomic(journal([{ number: 6001, voucherNumber: 502, accountingYear: '2026' }]));
    const result = await gateway.callTool('book_journal_entries', { journalNumber: 1, entryNumbers: [13] }, context);
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    const lookup = requests.find(request => request.path.endsWith('/AttachedDocuments'))!;
    expect(lookup.query.get('filter')).toBe('voucherNumber$eq:502$and:accountingYear$eq:2026');
  });

  it('refuses when the only document belongs to another year or no document is found', async () => {
    for (const documents of [[{ number: 6001, voucherNumber: 502, accountingYear: '2025' }], []]) {
      const { gateway, requests } = fakeEconomic(journal(documents));
      const result = await gateway.callTool('book_journal_entries', { journalNumber: 1, entryNumbers: [13] }, context);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('no verifiable attached document');
      expect(requests.some(request => request.method === 'POST')).toBe(false);
    }
  });
});
