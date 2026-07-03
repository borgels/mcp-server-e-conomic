import type { GatewayJsonObject, GatewayJsonValue } from '../gateway.js';

export interface GatewayContractFixture {
  text: string;
  structuredContent: GatewayJsonValue;
}

const rootContext = {
  mode: 'contract',
  agreement: {
    agreementNumber: 424242,
    name: 'Borgels Demo Agreement',
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

    case 'report_data':
      return collectionFixture('Fetched e-conomic contract report data.', input, accounts);

    case 'invoice_overview':
      return collectionFixture('Fetched e-conomic contract invoices.', input, bookedInvoices);

    case 'project_overview':
      return collectionFixture('Fetched e-conomic contract projects.', input, projects);

    case 'accounting_entries':
      return collectionFixture('Fetched e-conomic contract accounting entries.', input, bookedEntries);

    case 'create_draft_invoice':
      return draftInvoiceFixture(input);

    case 'upsert_customer':
      return upsertCustomerFixture(input);

    case 'upsert_product':
      return upsertProductFixture(input);

    case 'upsert_project':
      return upsertProjectFixture(input);

    case 'create_time_entry':
      return createTimeEntryFixture(input);

    default:
      return undefined;
  }
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
      self: `https://apis.e-conomic.com/projectsapi/v1.1.0/Projects/${resolvedNumber}`,
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
