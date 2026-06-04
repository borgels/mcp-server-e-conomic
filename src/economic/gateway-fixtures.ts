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

    default:
      return undefined;
  }
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
