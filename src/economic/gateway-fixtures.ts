import type { GatewayJsonObject, GatewayJsonValue } from '../gateway.js';

export interface GatewayContractFixture {
  text: string;
  structuredContent: GatewayJsonValue;
}

const rootContext = {
  mode: 'contract',
  agreement: {
    agreementNumber: 424242,
    name: 'Demo Agreement',
    country: 'DK',
    baseCurrency: 'DKK',
  },
  links: {
    customers: '/customers',
    products: '/products',
    accounts: '/accounts',
    projects: '/projects',
  },
};

/**
 * A GET /self answer in e-conomic's shape, including the parts company_context
 * must drop (bank details, the granting user, the app's tokens).
 */
export const economicGatewayContractSelf = {
  agreementNumber: 424242,
  agreementType: { agreementTypeNumber: 1, name: 'Demo' },
  company: {
    name: 'Demo Agreement',
    addressLine1: 'Eksempelvej 1',
    zip: '1000',
    city: 'Byen',
    country: 'Danmark',
    companyIdentificationNumber: '12345678',
    vatNumber: 'DK12345678',
    email: 'kontakt@example.test',
    phoneNumber: '+45 00 00 00 00',
  },
  bankInformation: { bankName: 'Demo Bank', bankAccountNumber: '0000000000', bankSortCode: '0000' },
  user: { name: 'Demo User', email: 'user@example.test', loginId: 'demo-login', agreementNumber: 424242 },
  userName: 'Demo User',
  application: { name: 'Demo App', appPublicToken: 'demo-public-token', requiredRoles: [] },
  modules: [{ moduleNumber: 1, name: 'Projekt' }],
  settings: { baseCurrency: 'DKK', internationalLedger: false },
};

const customers = [
  {
    customerNumber: 1001,
    name: 'Demo Servicekunde ApS',
    currency: 'DKK',
    paymentTerms: { paymentTermsNumber: 1, name: 'Netto 8 dage' },
    self: 'https://restapi.e-conomic.com/customers/1001',
  },
  {
    customerNumber: 1002,
    name: 'Nordic Field Service A/S',
    currency: 'DKK',
    paymentTerms: { paymentTermsNumber: 2, name: 'Netto 14 dage' },
    self: 'https://restapi.e-conomic.com/customers/1002',
  },
];

const products = [
  {
    productNumber: 'TIME-TECH',
    name: 'Teknikertime',
    salesPrice: 875,
    costPrice: 425,
    recommendedCostPrice: 425,
  },
  {
    productNumber: 'MAT-PUMP',
    name: 'Udskiftningspumpe',
    salesPrice: 2400,
    costPrice: 1600,
    recommendedCostPrice: 1600,
  },
];

const accounts = [
  { accountNumber: 1000, name: 'Debitorer', accountType: 'balanceSheet' },
  { accountNumber: 1010, name: 'Omsaetning service', accountType: 'profitAndLoss' },
];

const bookedInvoices = [
  {
    bookedInvoiceNumber: 70001,
    date: '2026-05-02',
    dueDate: '2026-05-10',
    currency: 'DKK',
    netAmount: 8000,
    grossAmount: 10000,
    remainder: 10000,
    customer: { customerNumber: 1001 },
  },
  {
    bookedInvoiceNumber: 70002,
    date: '2026-05-20',
    dueDate: '2026-06-03',
    currency: 'DKK',
    netAmount: 4000,
    grossAmount: 5000,
    remainder: 0,
    customer: { customerNumber: 1002 },
  },
];

const quotes = [
  {
    quoteNumber: 3001,
    date: '2026-05-01',
    currency: 'DKK',
    netAmount: 3500,
    grossAmount: 4375,
    customer: { customerNumber: 1001 },
    lines: [{ lineNumber: 1, product: { productNumber: 'TIME-TECH' }, quantity: 4, unitNetPrice: 875 }],
  },
];

const orders = [
  {
    orderNumber: 4001,
    date: '2026-05-03',
    currency: 'DKK',
    netAmount: 2400,
    grossAmount: 3000,
    customer: { customerNumber: 1002 },
    lines: [{ lineNumber: 1, product: { productNumber: 'MAT-PUMP' }, quantity: 1, unitNetPrice: 2400 }],
  },
];

const projects = [
  {
    projectNumber: 5001,
    name: 'Servicekontrakt Nord',
    projectGroup: { projectGroupNumber: 1 },
    customer: { customerNumber: 1001 },
    responsibleEmployee: { employeeNumber: 10 },
    barred: false,
  },
  {
    projectNumber: 5002,
    name: 'Anlaeg Syd',
    projectGroup: { projectGroupNumber: 2 },
    customer: { customerNumber: 1002 },
    responsibleEmployee: { employeeNumber: 11 },
    barred: false,
  },
];

const bookedEntries = [
  { entryNumber: 800001, accountNumber: 1010, amountInBaseCurrency: -8000, date: '2026-05-02', text: 'Faktura 70001' },
  { entryNumber: 800002, accountNumber: 1000, amountInBaseCurrency: 8000, date: '2026-05-02', text: 'Debitor 1001' },
];

export function economicGatewayContractFixture(
  toolName: string,
  input: GatewayJsonObject,
): GatewayContractFixture | undefined {
  switch (toolName) {
    case 'check_connection':
    case 'company_context':
      return {
        text: 'e-conomic contract fixture is available.',
        structuredContent: rootContext,
      };

    case 'search_entities':
      return collectionFixture('Fetched e-conomic contract entities.', input, customers);

    case 'customer_overview':
      return collectionFixture('Fetched e-conomic contract customers.', input, customers);

    case 'supplier_overview':
      return collectionFixture('Fetched e-conomic contract suppliers.', input, [
        { supplierNumber: 2001, name: 'Demo Grossist A/S', currency: 'DKK' },
      ]);

    case 'product_overview':
      return collectionFixture('Fetched e-conomic contract products.', input, products);

    case 'key_figures':
      return {
        text: 'Fetched e-conomic contract key figures.',
        structuredContent: {
          mode: 'contract',
          accountingYear: typeof input.accountingYear === 'string' ? input.accountingYear : '2026',
          fromDate: '2026-01-01',
          toDate: '2026-12-31',
          figures: {
            turnover: 12000,
            grossProfit: 7600,
            contributionMargin: 5200,
            resultBeforeDepreciation: 2100,
            operatingResult: 1900,
            resultBeforeTax: 1800,
            result: 1404,
          },
          balancesNow: { cash: 5935.5, receivables: 10000, supplierDebt: 2500, vatOwed: 1250 },
          invoicesNow: { unpaidGross: 10000, unpaidCount: 1, overdueGross: 0, overdueCount: 0 },
        },
      };

    case 'report_data':
      return collectionFixture('Fetched e-conomic contract report data.', input, accounts);

    case 'invoice_overview':
      return collectionFixture('Fetched e-conomic contract invoices.', input, bookedInvoices);

    case 'project_overview':
      return collectionFixture('Fetched e-conomic contract projects.', input, projects);

    case 'dimension_overview':
      return collectionFixture('Fetched e-conomic contract dimensions.', input, [
        { number: 1, name: 'Afdeling', active: true },
      ]);

    case 'set_entry_dimensions':
      return {
        text: 'Set a contract dimension value.',
        structuredContent: {
          mode: 'contract',
          dimensionNumber: numberOr(input.dimensionNumber, 0),
          dimensionKey: numberOr(input.dimensionKey, 0),
        },
      };

    case 'subscription_overview':
      return collectionFixture('Fetched e-conomic contract subscriptions.', input, [
        { number: 1, name: 'Serviceaftale, kvartal', interval: 3, isBarred: false },
      ]);

    case 'add_subscriber':
      return {
        text: 'Added a contract subscriber.',
        structuredContent: {
          mode: 'contract',
          number: 31,
          subscriptionNumber: numberOr(input.subscriptionNumber, 0),
          customerNumber: numberOr(input.customerNumber, 0),
          startDate: typeof input.startDate === 'string' ? input.startDate : '2026-01-01',
        },
      };

    case 'end_subscriber':
      return {
        text: 'Ended a contract subscriber.',
        structuredContent: {
          mode: 'contract',
          number: numberOr(input.subscriberNumber, 0),
          expiryDate: typeof input.expiryDate === 'string' ? input.expiryDate : '2026-12-31',
        },
      };

    case 'quote_overview':
      return collectionFixture('Fetched e-conomic contract quotes.', input, quotes);

    case 'order_overview':
      return collectionFixture('Fetched e-conomic contract orders.', input, orders);

    case 'get_document':
      if (input.pdf === true) {
        return {
          text: 'Fetched e-conomic contract PDF.',
          structuredContent: { contentType: 'application/pdf', sizeBytes: 9, base64: 'JVBERi0xLjcK' },
        };
      }
      return collectionFixture('Fetched e-conomic contract documents.', input, [
        { number: 6001, pageCount: 1, voucherNumber: 501, accountingYear: '2026' },
      ]);

    case 'attach_voucher_file':
      return {
        text: 'Attached a contract document.',
        structuredContent: {
          mode: 'contract',
          number: 6002,
          voucherNumber: numberOr(input.voucherNumber, 0),
          accountingYear: typeof input.accountingYear === 'string' ? input.accountingYear : '2026',
        },
      };

    case 'accounting_entries':
      return collectionFixture('Fetched e-conomic contract accounting entries.', input, bookedEntries);

    case 'create_draft_invoice':
      return draftInvoiceFixture(input);

    case 'create_draft_quote':
    case 'create_draft_order':
      return salesDraftFixture(toolName, input);

    case 'upgrade_quote':
    case 'upgrade_order': {
      const toOrder = toolName === 'upgrade_quote' && input.to === 'order';
      const from = numberOr(toolName === 'upgrade_quote' ? input.quoteNumber : input.orderNumber, 0);
      return {
        text: `Turned the contract ${toolName === 'upgrade_quote' ? 'quote' : 'order'} into a ${toOrder ? 'draft order' : 'draft invoice'}. Not booked or sent.`,
        structuredContent: toOrder
          ? { mode: 'contract', orderNumber: 4002, quoteNumber: from }
          : { mode: 'contract', draftInvoiceNumber: 90100, from },
      };
    }

    case 'upsert_customer':
      return upsertCustomerFixture(input);

    case 'upsert_product':
      return upsertProductFixture(input);

    case 'upsert_project':
      return upsertProjectFixture(input);

    case 'create_time_entry':
      return createTimeEntryFixture(input);

    case 'update_time_entry':
      return {
        text: 'Changed the contract time entry.',
        structuredContent: {
          mode: 'contract',
          number: numberOr(input.timeEntryNumber, 0),
          ...(typeof input.hours === 'number' ? { numberOfHours: input.hours } : {}),
          ...(typeof input.date === 'string' ? { date: input.date } : {}),
        },
      };

    case 'create_mileage_entry':
      return {
        text: 'Registered contract mileage.',
        structuredContent: {
          mode: 'contract',
          number: 77,
          projectNumber: numberOr(input.projectNumber, 0),
          employeeNumber: numberOr(input.employeeNumber, 0),
          distance: numberOr(input.distance, 0),
        },
      };

    case 'approve_time_entries':
      return {
        text: 'Approved contract time entries.',
        structuredContent: { mode: 'contract', action: 'approved', numbers: numberList(input.timeEntryNumbers) },
      };

    case 'upsert_supplier':
      return upsertSupplierFixture(input);

    case 'upsert_employee':
      return upsertEmployeeFixture(input);

    case 'upsert_account':
      return upsertAccountFixture(input);

    case 'create_journal_entries':
    case 'register_payment':
      return journalVoucherFixture(toolName, input);

    case 'book_journal_entries':
      return {
        text: 'Booked e-conomic contract journal entries.',
        structuredContent: {
          mode: 'contract',
          action: 'booked',
          journalNumber: numberOr(input.journalNumber, 1),
          entryNumbers: numberList(input.entryNumbers),
          voucherNumbers: numberList(input.voucherNumbers),
        },
      };

    case 'book_journal':
      return {
        text: 'Booked e-conomic contract journal.',
        structuredContent: {
          mode: 'contract',
          action: 'booked',
          journalNumber: numberOr(input.journalNumber, 1),
          entryCount: numberOr(input.entryCount, 0),
        },
      };

    case 'delete_journal_entry':
      return {
        text: 'Deleted e-conomic contract draft entry.',
        structuredContent: {
          mode: 'contract',
          action: 'deleted',
          journalNumber: numberOr(input.journalNumber, 1),
          entryNumber: numberOr(input.entryNumber, 0),
        },
      };

    case 'delete_draft_invoice':
    case 'delete_draft_quote':
    case 'delete_draft_order':
    case 'delete_time_entry': {
      const field = { delete_draft_invoice: 'draftInvoiceNumber', delete_draft_quote: 'quoteNumber', delete_draft_order: 'orderNumber', delete_time_entry: 'timeEntryNumber' }[toolName];
      return {
        text: `Deleted e-conomic contract record (${toolName}).`,
        structuredContent: { mode: 'contract', action: 'deleted', [field]: numberOr(input[field], 0) },
      };
    }

    case 'book_invoice':
      return {
        text: 'Booked e-conomic contract draft invoice.',
        structuredContent: {
          mode: 'contract',
          action: 'booked',
          draftInvoiceNumber: numberOr(input.draftInvoiceNumber, 0),
          bookedInvoiceNumber: 70002,
        },
      };

    case 'match_open_items':
      return {
        text: 'Matched e-conomic contract open items.',
        structuredContent: { mode: 'contract', action: 'matched', entryIds: numberList(input.entryIds) },
      };

    default:
      return undefined;
  }
}

function upsertAccountFixture(input: GatewayJsonObject): GatewayContractFixture {
  const accountNumber = typeof input.accountNumber === 'number' ? input.accountNumber : 0;
  const exists = accounts.some(account => account.accountNumber === accountNumber);
  const action = exists ? 'updated' : 'created';

  return {
    text: `${action === 'created' ? 'Created' : 'Updated'} e-conomic contract account.`,
    structuredContent: {
      mode: 'contract',
      action,
      accountNumber,
      name: typeof input.name === 'string' ? input.name : 'Ny konto',
      accountType: typeof input.accountType === 'string' ? input.accountType : 'profitAndLoss',
      self: `https://restapi.e-conomic.com/accounts/${accountNumber}`,
    },
  };
}

function upsertSupplierFixture(input: GatewayJsonObject): GatewayContractFixture {
  const supplierNumber = typeof input.supplierNumber === 'number' ? input.supplierNumber : undefined;
  const action = supplierNumber === undefined ? 'created' : 'updated';
  const resolvedNumber = supplierNumber ?? 2002;

  return {
    text: `${action === 'created' ? 'Created' : 'Updated'} e-conomic contract supplier.`,
    structuredContent: {
      mode: 'contract',
      action,
      supplierNumber: resolvedNumber,
      name: typeof input.name === 'string' ? input.name : 'Demo Grossist A/S',
      currency: typeof input.currency === 'string' ? input.currency : 'DKK',
      self: `https://restapi.e-conomic.com/suppliers/${resolvedNumber}`,
    },
  };
}

function upsertEmployeeFixture(input: GatewayJsonObject): GatewayContractFixture {
  const employeeNumber = typeof input.employeeNumber === 'number' ? input.employeeNumber : undefined;
  const action = employeeNumber === undefined ? 'created' : 'updated';
  const resolvedNumber = employeeNumber ?? 12;

  return {
    text: `${action === 'created' ? 'Created' : 'Updated'} e-conomic contract project employee.`,
    structuredContent: {
      mode: 'contract',
      action,
      employeeNumber: resolvedNumber,
      name: typeof input.name === 'string' ? input.name : 'Demo Medarbejder',
      self: `https://apis.e-conomic.com/projectsapi/v1.1.1/Employees/${resolvedNumber}`,
    },
  };
}

function upsertProjectFixture(input: GatewayJsonObject): GatewayContractFixture {
  const projectNumber = typeof input.projectNumber === 'number' ? input.projectNumber : undefined;
  const action = projectNumber === undefined ? 'created' : 'updated';
  const resolvedNumber = projectNumber ?? 5003;

  return {
    text: `${action === 'created' ? 'Created' : 'Updated'} e-conomic contract project.`,
    structuredContent: {
      mode: 'contract',
      action,
      projectNumber: resolvedNumber,
      name: typeof input.name === 'string' ? input.name : 'Servicekontrakt Nord',
      self: `https://apis.e-conomic.com/projectsapi/v1.1.1/Projects/${resolvedNumber}`,
    },
  };
}

function createTimeEntryFixture(input: GatewayJsonObject): GatewayContractFixture {
  const projectNumber = typeof input.projectNumber === 'number' ? input.projectNumber : 0;
  const hours = typeof input.hours === 'number' ? input.hours : 0;

  return {
    text: 'Registered e-conomic contract project time.',
    structuredContent: {
      mode: 'contract',
      timeEntryNumber: 900000 + projectNumber,
      project: { projectNumber },
      activity: { activityNumber: typeof input.activityNumber === 'number' ? input.activityNumber : 0 },
      employee: { employeeNumber: typeof input.employeeNumber === 'number' ? input.employeeNumber : 0 },
      date: typeof input.date === 'string' ? input.date : '2026-05-02',
      hours,
    },
  };
}

export function economicGatewayContractEntity(input: GatewayJsonObject): GatewayContractFixture {
  const selfUrl = typeof input.selfUrl === 'string' ? input.selfUrl : undefined;
  const serviceId = typeof input.serviceId === 'string' ? input.serviceId : undefined;
  const resource = typeof input.resource === 'string' ? input.resource : undefined;
  const number = typeof input.number === 'string' || typeof input.number === 'number' ? input.number : undefined;

  return {
    text: 'Fetched e-conomic contract entity.',
    structuredContent: {
      mode: 'contract',
      selfUrl: selfUrl ?? null,
      serviceId: serviceId ?? null,
      resource: resource ?? null,
      number: number ?? null,
      entity: entityFor(serviceId, number),
    },
  };
}

function draftInvoiceFixture(input: GatewayJsonObject): GatewayContractFixture {
  const customerNumber = typeof input.customerNumber === 'number' ? input.customerNumber : 0;
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  let netAmount = 0;
  const lines = rawLines.map((source, index) => {
    const line = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const quantity = typeof line.quantity === 'number' ? line.quantity : 0;
    const unitNetPrice = typeof line.unitNetPrice === 'number' ? line.unitNetPrice : 0;
    netAmount += quantity * unitNetPrice;
    return {
      lineNumber: index + 1,
      product: { productNumber: typeof line.productNumber === 'string' || typeof line.productNumber === 'number' ? line.productNumber : null },
      description: typeof line.description === 'string' ? line.description : null,
      quantity,
      unitNetPrice,
    } satisfies GatewayJsonObject;
  });
  const draftInvoiceNumber = 90000 + customerNumber;

  return {
    text: 'Created e-conomic contract draft invoice.',
    structuredContent: {
      mode: 'contract',
      draftInvoiceNumber,
      customer: { customerNumber },
      currency: typeof input.currency === 'string' ? input.currency : 'DKK',
      netAmount,
      grossAmount: Math.round(netAmount * 1.25 * 100) / 100,
      lines,
      self: `https://restapi.e-conomic.com/invoices/drafts/${draftInvoiceNumber}`,
    },
  };
}

function salesDraftFixture(toolName: string, input: GatewayJsonObject): GatewayContractFixture {
  const invoice = draftInvoiceFixture(input).structuredContent as Record<string, GatewayJsonValue>;
  const quote = toolName === 'create_draft_quote';
  const number = (quote ? 30000 : 40000) + numberOr(input.customerNumber, 0);
  const content: Record<string, GatewayJsonValue> = { ...invoice };
  delete content.draftInvoiceNumber;
  content[quote ? 'quoteNumber' : 'orderNumber'] = number;
  content.self = `https://restapi.e-conomic.com/${quote ? 'quotes' : 'orders'}/drafts/${number}`;
  return { text: `Created e-conomic contract ${quote ? 'draft quote' : 'draft order'}.`, structuredContent: content };
}

function upsertCustomerFixture(input: GatewayJsonObject): GatewayContractFixture {
  const customerNumber = typeof input.customerNumber === 'number' ? input.customerNumber : undefined;
  const action = customerNumber === undefined ? 'created' : 'updated';
  const resolvedNumber = customerNumber ?? 1003;

  return {
    text: `${action === 'created' ? 'Created' : 'Updated'} e-conomic contract customer.`,
    structuredContent: {
      mode: 'contract',
      action,
      customerNumber: resolvedNumber,
      name: typeof input.name === 'string' ? input.name : 'Demo Servicekunde ApS',
      currency: typeof input.currency === 'string' ? input.currency : 'DKK',
      self: `https://restapi.e-conomic.com/customers/${resolvedNumber}`,
    },
  };
}

function upsertProductFixture(input: GatewayJsonObject): GatewayContractFixture {
  const productNumber =
    typeof input.productNumber === 'string' || typeof input.productNumber === 'number'
      ? String(input.productNumber)
      : 'NEW-PRODUCT';
  const exists = products.some(product => product.productNumber === productNumber);
  const action = exists ? 'updated' : 'created';

  return {
    text: `${action === 'created' ? 'Created' : 'Updated'} e-conomic contract product.`,
    structuredContent: {
      mode: 'contract',
      action,
      productNumber,
      name: typeof input.name === 'string' ? input.name : 'Teknikertime',
      salesPrice: typeof input.salesPrice === 'number' ? input.salesPrice : 875,
      self: `https://restapi.e-conomic.com/products/${encodeURIComponent(productNumber)}`,
    },
  };
}

function collectionFixture(
  text: string,
  input: GatewayJsonObject,
  items: GatewayJsonObject[],
): GatewayContractFixture {
  const number = typeof input.number === 'string' || typeof input.number === 'number' ? input.number : undefined;
  const filtered = number === undefined ? items : items.filter(item => Object.values(item).includes(number));

  return {
    text,
    structuredContent: {
      mode: 'contract',
      serviceId: typeof input.serviceId === 'string' ? input.serviceId : null,
      resource: typeof input.resource === 'string' ? input.resource : null,
      collection: filtered,
      pagination: {
        count: filtered.length,
        deterministic: true,
      },
    },
  };
}

function entityFor(serviceId: string | undefined, number: string | number | undefined): GatewayJsonObject {
  if (serviceId === 'products') {
    return products.find(product => product.productNumber === number) ?? products[0] ?? {};
  }

  if (serviceId === 'accounts') {
    return accounts.find(account => account.accountNumber === number) ?? accounts[0] ?? {};
  }

  return customers.find(customer => customer.customerNumber === number) ?? customers[0] ?? {};
}

function numberOr(value: GatewayJsonValue | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function numberList(value: GatewayJsonValue | undefined): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

function journalVoucherFixture(toolName: string, input: GatewayJsonObject): GatewayContractFixture {
  const lines = toolName === 'register_payment' ? 1 : Array.isArray(input.entries) ? input.entries.length : 0;
  return {
    text: toolName === 'register_payment'
      ? 'Registered e-conomic contract payment as a draft journal line. Not booked.'
      : 'Added e-conomic contract draft journal lines. Not booked.',
    structuredContent: {
      mode: 'contract',
      action: 'created',
      journalNumber: numberOr(input.journalNumber, 1),
      voucherNumber: numberOr(input.voucherNumber, 1001),
      lines,
    },
  };
}
