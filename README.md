# mcp-server-e-conomic

TypeScript MCP server for Visma e-conomic APIs. It is intentionally boring good:
typed, documented, read-first, policy-aware, credential-sane, and audit-friendly.

> **Disclaimer:** This is an independent, unofficial project. It is not developed,
> endorsed or supported by Visma e-conomic. "Visma", "e-conomic", and the e-conomic
> APIs are referenced only to describe what this server talks to. You need your own
> e-conomic credentials, and use of the e-conomic APIs is subject to
> Visma/e-conomic's own terms.

## Scope

The server exposes e-conomic through three layers:

- Curated MCP tools for common accounting workflows.
- Discovery tools so MCP clients can find supported resources and endpoint shapes.
- A validated endpoint caller for long-tail coverage, allowlisted against the
  known e-conomic API catalog.

Default install mode is read-only. Writes require explicit environment opt-in,
policy approval, a prepared operation hash, a reason, and an idempotency key.

## Setup

Install dependencies and build the CLI:

```sh
npm install
npm run build
```

Set e-conomic credentials in the MCP server environment. The server sends these
as e-conomic's documented headers and never accepts credentials as tool
arguments.

```sh
export ECONOMIC_APP_SECRET_TOKEN="your-app-secret-token"
export ECONOMIC_AGREEMENT_GRANT_TOKEN="your-agreement-grant-token"
```

### Getting Real Credentials

e-conomic's token model has three names that are easy to mix up:

- App Secret Token: a private token for your app. This becomes
  `ECONOMIC_APP_SECRET_TOKEN` and is sent as `X-AppSecretToken`.
- App Public Token: a public app identifier used to create the Installation URL.
  It is not sent by this MCP server on API requests.
- Agreement Grant Token: created when an accounting agreement user grants your
  app access. This becomes `ECONOMIC_AGREEMENT_GRANT_TOKEN` and is sent as
  `X-AgreementGrantToken`.

Create the app-side tokens first:

1. Create or sign in to an e-conomic developer agreement.
2. Open the developer area's Apps tab.
3. Create a new app and select the roles/scopes your integration needs.
4. Save the app and copy the App Secret Token and App Public Token.
5. Store the App Secret Token in a password manager or secret store. Treat it as
   a real secret; reset it in e-conomic if it is lost or exposed.

Then create the agreement-side token:

1. Use the app's Installation URL, or build one from the App Public Token:

   ```text
   https://secure.e-conomic.com/secure/api1/requestaccess.aspx?appPublicToken=YOUR_APP_PUBLIC_TOKEN
   ```

2. Open that URL while logged into the e-conomic agreement that should grant
   access.
3. Approve adding the app.
4. Copy the shown Agreement Grant Token, or configure a redirect URL and let the
   helper below capture it.

If your e-conomic app is configured with a redirect URL, this repository includes
a local callback helper that can capture the Agreement Grant Token after the user
approves access:

```sh
export ECONOMIC_APP_PUBLIC_TOKEN="your-app-public-token"
npm run auth:grant
```

You can also pass the full Installation URL instead:

```sh
export ECONOMIC_INSTALLATION_URL="https://secure.e-conomic.com/secure/api1/requestaccess.aspx?appPublicToken=..."
npm run auth:grant
```

The helper prints a local callback URL such as:

```text
http://127.0.0.1:3333/economic/grant/callback
```

Configure that URL as the app installation redirect URL in e-conomic if your
agreement/app setup allows local redirects. For shared or production onboarding,
use the same redirect flow with a small HTTPS endpoint you control. After the
logged-in user approves access, e-conomic redirects back with `?token=...`; the
helper prints the matching `ECONOMIC_AGREEMENT_GRANT_TOKEN` export line. Treat
both tokens as secrets.

For GET-only demo mode, e-conomic documents that both tokens can be set to
`demo`:

```sh
export ECONOMIC_APP_SECRET_TOKEN="demo"
export ECONOMIC_AGREEMENT_GRANT_TOKEN="demo"
```

## Claude Or Cursor Config

Use the stdio server for local MCP clients:

```json
{
  "mcpServers": {
    "e-conomic": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-e-conomic/dist/stdio.js"],
      "env": {
        "ECONOMIC_APP_SECRET_TOKEN": "your-app-secret-token",
        "ECONOMIC_AGREEMENT_GRANT_TOKEN": "your-agreement-grant-token"
      }
    }
  }
}
```

During development:

```json
{
  "mcpServers": {
    "e-conomic": {
      "command": "npm",
      "args": ["run", "dev", "--prefix", "/absolute/path/to/mcp-server-e-conomic"],
      "env": {
        "ECONOMIC_APP_SECRET_TOKEN": "demo",
        "ECONOMIC_AGREEMENT_GRANT_TOKEN": "demo"
      }
    }
  }
}
```

## Start Here

Ask the MCP client to call:

- `economic_search_capabilities` to find tools, schemas, and endpoint operations.
- `economic_get_capability` to inspect one capability before calling it.
- `economic_get_schema` to inspect known resources for an API area.
- `economic_check_connection` to verify credentials.

## Main Tools

Discovery:

- `economic_search_capabilities`
- `economic_get_capability`
- `economic_get_schema`

Read tools:

- `economic_check_connection`
- `economic_get_company_context`
- `economic_search_entities`
- `economic_get_entity`
- `economic_get_customer_overview`
- `economic_get_supplier_overview`
- `economic_get_product_overview`
- `economic_get_sales_document`
- `economic_get_accounting_entries`
- `economic_get_project_overview`
- `economic_get_document`
- `economic_get_report`
- `economic_reconcile_open_items`
- `economic_validate_payload`

Write preparation and commit:

- `economic_prepare_customer_change`
- `economic_prepare_product_change`
- `economic_prepare_product_group_change`
- `economic_prepare_sales_document`
- `economic_prepare_journal_entry`
- `economic_prepare_payment_registration`
- `economic_prepare_project_change`
- `economic_prepare_project_group_change`
- `economic_prepare_employee_change`
- `economic_prepare_time_entry`
- `economic_commit_prepared_operation`
- `economic_attach_voucher_file`
- `economic_attach_sales_invoice_file`

The project tools target the e-conomic Projects (Projektregnskab) add-on. Projects
collect per-job revenue and cost, project groups route project registrations to
accounts, and employees provide the responsible person required on a project.
`economic_prepare_time_entry` registers hours against a project/activity/employee.
The Projects add-on upserts via the collection: create with `POST /X`, update with
`PUT /X` (the full object including its number and `objectVersion`), delete with
`DELETE /X/{number}`. Item-level `PUT /X/{number}` and `PATCH` return HTTP 405, and
a `PUT` is a full replace (omitted fields are cleared). Project status, cost types
and activities are read-only via the API and managed in the e-conomic UI; time
entries support create and delete only. In the embedded gateway,
`delete_time_entry` deletes a time entry that is neither approved nor
reconciled (invoiced).

Long-tail coverage:

- `economic_call_endpoint`

`economic_call_endpoint` is not arbitrary HTTP. It only calls allowlisted
e-conomic API operations and is read-only unless write policy permits the call.

## Write Policy

Writes are blocked unless explicitly enabled:

```sh
export ECONOMIC_ENABLE_WRITES=true
export ECONOMIC_POLICY_PATH="/absolute/path/to/economic-policy.json"
export ECONOMIC_AUDIT_LOG="/absolute/path/to/economic-audit.jsonl"
```

Example policy:

```json
{
  "writesEnabled": true,
  "allowedCapabilities": [
    "economic_prepare_customer_change",
    "economic_prepare_product_change"
  ],
  "allowedServices": ["customers", "products"],
  "allowedMethods": ["POST", "PUT"],
  "deniedPathPatterns": [
    "/journals/.*/book",
    "/entries/draft/.*/book",
    "/booked-entries/match",
    "/webhooks",
    "/vat",
    "/payment"
  ],
  "maxAmount": 10000
}
```

Write flow:

1. Call a `economic_prepare_*` tool with a business reason.
2. Inspect the returned dry-run payload and `operationHash`.
3. Call `economic_commit_prepared_operation` with the full prepared operation,
   matching `confirmOperationHash`, and an `idempotencyKey`.

Prepared operations are signed by the server (HMAC-SHA256) and expire after 15
minutes. Commit only accepts operations this server signed; it re-evaluates the
write policy against the current configuration and ignores the
`policyDecision` returned by prepare. Booking and open-item match commits also
re-run every booking guardrail (entries, `maxAmount`, vouchers) right before
executing.

```sh
# Optional: shared signing secret (use a long random value). Without it, a
# random per-process secret is used and prepared operations do not survive a
# restart or work across replicas.
export ECONOMIC_PREPARE_SECRET="..."
```

Each `economic_prepare_*` capability can only target its own fixed set of
endpoints (for example, `economic_prepare_customer_change` can only write
customer resources), and commit checks the same mapping, so
`allowedCapabilities` in the policy restricts which resources can be written.

## Security And Audit

If `ECONOMIC_AUDIT_LOG` is set, every mutating attempt writes a JSONL record with
timestamp, request id, tool, service, method/path, operation hash, policy
decision, idempotency-key hash, status, and redacted errors. Secrets are never
logged intentionally.

Credentials are read only from the MCP server environment and are never accepted
as tool arguments. Report suspected vulnerabilities privately to
<security@borgels.com>. Do not include API tokens, accounting data, or other
secrets in public GitHub issues.

## Optional HTTP Server

The local stdio transport is the default. A small Streamable HTTP entrypoint is
available:

```sh
PORT=3000 ECONOMIC_APP_SECRET_TOKEN="demo" ECONOMIC_AGREEMENT_GRANT_TOKEN="demo" npm run dev:http
```

By default the HTTP server binds to `127.0.0.1`, limits request bodies to 10 MiB
and allows browser CORS only from loopback origins. A token is optional on
loopback; on any other bind address (for example `0.0.0.0` in a container)
`MCP_HTTP_TOKEN` is required. The Bearer token is compared in constant time.
If any `*_TRUST_FORWARDED_USER` variable is set to `true` (for deployments
behind an identity-forwarding proxy), the HTTP server refuses to start unless
`MCP_HTTP_TOKEN` is also set.

The MCP endpoint is `POST http://127.0.0.1:3000/mcp`.

### HTTP Settings

The HTTP transport serves `POST /mcp` (stateless Streamable HTTP) and an
unauthenticated `GET /healthz`. It binds to `127.0.0.1` unless told otherwise.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | – | Bearer token for `/mcp`: at least 32 printable ASCII characters, e.g. `openssl rand -hex 32`. **Required** on a non-loopback bind and with `MCP_ALLOW_ANY_ORIGIN=true`; the server refuses to start otherwise. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Start without a token where one would be required. Only for setups where access is restricted by other means; logs a warning. |
| `MCP_ALLOWED_ORIGINS` | – | Comma-separated browser origins allowed to call `/mcp`. Default: localhost origins. Requests without an `Origin` header (server-to-server) are not affected. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any browser origin. Requires `MCP_HTTP_TOKEN`. |
| `MCP_ALLOWED_HOSTS` | – | Comma-separated host names accepted in the `Host` header. Default: on a loopback bind only `localhost`, `127.0.0.1`, `[::1]` and the bind address; no check on other binds. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Request body limit; larger requests get 413. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address within the window before further failures get 429. `0` disables. Requests with a valid token are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for `MCP_AUTH_FAILURE_LIMIT`. |

Invalid values (a non-numeric `PORT`, a misspelt boolean) stop the server at
startup with a message naming the variable. Rejected requests get a JSON error
(401 with `WWW-Authenticate: Bearer`, 400 for invalid JSON, 413 for oversized
bodies) and one log line on stderr. The server shuts down gracefully on
SIGTERM/SIGINT.

## Security Model

- The server acts with one shared e-conomic identity: the credentials in its
  environment. Everyone who can call it acts with the same rights.
- `MCP_HTTP_TOKEN` decides who may call the server at all. It does not tell
  users apart. Per-user authorization belongs in an identity-aware gateway in
  front of the server.
- Tool access is not data access. Disabling or hiding tools limits what a
  client can call, but the upstream credentials decide what data the server can
  reach. Scope those credentials as narrowly as the use case allows.
- The HTTP server does not terminate TLS. Run it behind a reverse proxy that
  does, or keep it on a private network.

## Gateway Contract

`mcp-server-e-conomic/gateway` is the supported package export for embedding
hosts (for example a gateway that filters tools by role and logs every call)
that need to wrap e-conomic without copying connector logic.

The gateway exports:

- `economicGatewayTools`: stable unprefixed tool definitions with name, title,
  description, risk level, default enablement, and JSON input schema.
- `economicToolCatalog`: the same tools as a frozen catalog
  (`GatewayToolCatalogEntry[]`), generated from the tool table. Each entry has
  `upstream`: every e-conomic request the tool may make, as
  `{ access, method, path, serviceId, resource }` (`path` relative to the REST
  base URL, or to the OpenAPI base URL including the service path). For a
  narrow read tool, `upstream` is exactly what its enforced target list allows,
  and a test checks that every request any tool makes is declared there.
  e-conomic additions: `broad` (true only for `get_entity`) and `defaultRead`.
- `economicServiceCatalog`: the frozen service catalog: services, their
  resources, and every allowlisted endpoint with `access: 'read' | 'write'`.
- `resolveEconomicReadTarget(tool, input)`: what a read call will read, with
  the same checks `callTool` applies before sending anything. Useful for
  logging the target of a call.
- `resolveEconomicChange(tool, input)`: what a write call will change, for a
  host that logs a change before it is sent: `{ tool, action, record,
  booking, values }`. Each write tool's catalog entry carries
  `change: { action, record, logFields }` and `booking`; every log field
  has one type (`recordNumber`, `numberList`, `amount`, `quantity`,
  `date`, `currency`, `accountingYear`, `enum`), and `values` holds
  only the fields whose input has that type, plus `lineCount` for tools with
  lines. A name or free text never reaches `values`; free-text identifiers
  such as a supplier's own invoice number are not log fields.
- `createEconomicGateway(options)`: a factory taking `appSecretToken`
  (required outside contract mode), an optional single-tenant
  `agreementGrantToken`, optional base URLs, timeout, `fetchImpl`,
  `contractMode`, `enableWrites` and `policy` (the host policy, below).
- `gateway.callTool(name, input, context?)` with
  `context = { caller?, requestId?, credentials?: { agreementGrantToken } }`.
  A multi-tenant host passes each company's agreement grant token per call.
  When `credentials` is present it is the only source of the token for that
  call.
- `EconomicGateway`: the type of a gateway instance.

The embedded gateway never reads `ECONOMIC_*` environment variables
(credentials, base URLs, timeout, write and policy flags); those configure the
standalone server only. Token values are redacted by a redactor owned by the
gateway instance (and per call for a per-call token), not by process-wide
state. Errors, including upstream HTTP failures, are returned as `isError`
results with a redacted message.

Read gateway tools. Each narrow tool reads only its listed targets; the first
is the default. Anything else is refused before a request is sent.

| Tool | Reads (`serviceId:resource`) |
| --- | --- |
| `check_connection` | `rest:self` (returns only `{ connected: true }`) |
| `company_context` | `rest:self`, filtered to company name, address, CVR/VAT number, agreement number and type, modules, base currency and international ledger |
| `search_entities` | `rest:customers`, `rest:suppliers`, `rest:products`, `rest:accounts`, `projects:Projects` |
| `customer_overview` | `customers:Customers`, `customers:Contacts`, `customers:DeliveryLocations`, `rest:customers`, `rest:customer-groups` |
| `supplier_overview` | `rest:suppliers`, `rest:supplier-groups`, `suppliers:Contacts`, `suppliers:Groups` |
| `product_overview` | `products:products`, `products:productgroups`, `products:pricegroups`, `products:salespriceincurrencies`, `rest:products`, `rest:product-groups`, `rest:units` |
| `report_data` | `accounts:Accounts`, `accounts:KeyFigureCodes`, `accounts:TotalIntervals`, `rest:accounts`, `rest:accounting-years`, `accounting-years:AccountingYears`, `accounting-years:accountingYears/periods`, `budgets:budget-figures` |
| `invoice_overview` | `rest:invoices/booked`, `rest:invoices/unpaid`, `rest:invoices/overdue`, `rest:invoices/paid`, `rest:invoices/sent`, `rest:invoices/drafts` |
| `project_overview` | `projects:Projects`, `projects:ProjectGroups`, `projects:ProjectStatuses`, `projects:CostTypes`, `projects:Activities`, `projects:ActivityGroups`, `projects:Employees`, `projects:EmployeeGroups`, `projects:TimeEntries` |
| `accounting_entries` | `booked-entries:booked-entries`, `booked-entries:booked-entries/matched-pairs`, `journals:draft-entries` |
| `get_entity` | **Broad** (`broad: true`): one record from any read endpoint in the service catalog, by `serviceId`/`resource`/`number` or a self URL. Give it only to callers that may read all of the agreement's data. |

Write gateway tools, disabled by default:

| Tool | Risk | What it does |
| --- | --- | --- |
| `create_draft_invoice` | write | Draft sales invoice (not booked, not sent) |
| `upsert_customer`, `upsert_product`, `upsert_project` | write | Master data, read-merge-write |
| `create_time_entry` | write | Project time |
| `upsert_supplier` | write | Supplier master data; bank fields are refused |
| `upsert_employee` | write | Projects add-on employee |
| `upsert_account` | destructive | Chart of accounts. Always refused by the gateway's fence (below) |
| `create_journal_entries` | write | One voucher with draft lines in a journal (kassekladde): ledger lines and supplier invoices. Not booked |
| `register_payment` | write | A customer or supplier payment as a draft journal line. Not booked; records the payment, does not move money |
| `book_journal` | write, booking | Books every draft entry of one journal (max 100). The caller gives the number of entries (`entryCount`); when the journal holds another number, nothing is booked. Exactly the entries read and checked are booked, through `bookdraftentries`, with the same guardrails as `book_journal_entries`. Log values: the journal number and the number of entries |
| `book_journal_entries` | write, booking | Books explicit draft entries (by entry or voucher numbers, max 25) with the booking guardrails: entries must exist in the journal; vouchers need an attached document unless `requireVoucher: false` |
| `book_invoice` | write, booking | Books a draft invoice (`POST /invoices/booked`, `sendBy: none`: never sent electronically) |
| `match_open_items` | write, booking | Matches booked open items (no API undo) |
| `delete_journal_entry` | write | Deletes one draft entry (not booked) from a journal: it must be found as a draft entry of that journal |
| `delete_draft_invoice` | write | Deletes a draft invoice (a draft is neither booked nor sent) |
| `delete_time_entry` | write | Deletes a time entry that is neither approved nor reconciled (invoiced) |

The delete tools read the record's status at e-conomic right before the
`DELETE`. When the record is not found as a draft, or the status cannot be
read (any other error, or an answer without a body), nothing is deleted.

In the embedding, one call is one change: there is no prepare/commit step,
because the host logs the change (`resolveEconomicChange`) before it calls.
The prepare and commit tools remain on the full MCP server surface.

The fence (`GATEWAY_FENCE`, exported): requests the gateway never sends,
whatever the host policy or the app's role at e-conomic. It is checked in the
HTTP client right before a request goes out, so a new tool cannot open one by
mistake: every `DELETE` except on the three draft paths in `GATEWAY_DELETABLE`
(a draft journal entry, a draft invoice and a time entry),
any path with a `delete`/`deletebulk` segment, and
writes to the company record (`/self`, including bank information, the user
and settings), anything with `bank` in the path, users, app roles, agreements
and settings, webhooks, the whole-journal booking paths (`/book`,
`bookWithDateInterval`, which book whatever the journal holds when e-conomic
runs them; `book_journal` and `book_journal_entries` book checked entries
through `bookdraftentries`),
accounting years and the chart of accounts (`/accounts`). Write tools accept
only the fields in their schema; nothing is passed through to e-conomic. The
credential headers are set by the client and cannot be given with a request,
and both tokens are redacted from every error and every answer.

Host policy (`policy` option, `EconomicHostPolicy`; every field optional,
checked at creation, applies in contract mode too):

```ts
const gateway = createEconomicGateway({
  appSecretToken,
  policy: {
    enableWrites: true,               // write tools may run (default false)
    allowBooking: true,               // booking tools may run (default false; needs enableWrites)
    disabledTools: ['upsert_account'],// not listed in gateway.tools, refused by callTool
    // allowedTools: [...],           // allow-list: only these tools are offered
  },
});
```

Unknown tool names, an empty `allowedTools`, `allowBooking` without writes,
and `enableWrites` given both as an option and in `policy` with different
values all throw. `gateway.policy` is the resolved policy. In contract mode
write tools are refused unless writes are enabled, as in live mode. The top-level
`enableWrites` option still works on its own.

What no policy turns on:

- **Bank details.** A write whose input or body carries a bank field is
  refused before anything is sent: `bankAccount`, `remittanceAdvice`
  (creditor id, payment type), `paymentDetails` (FI/giro numbers, OCR lines),
  `bankInformation`, and keys naming IBAN, SWIFT/BIC, giro, sort code or
  registration number. A supplier update keeps the current bank details
  unchanged (read-merge-write) and is refused if any would change. Writes to
  the company record (`/self`) are denied by the built-in policy. The
  standalone server's `economic_call_endpoint` and
  `economic_commit_prepared_operation` apply the same guard.
- **Deletion.** Only the three delete tools send `DELETE`, each on its one
  draft endpoint, after reading the record's status. Booked or sent records,
  customers, suppliers, products, accounts and everything else cannot be
  deleted; the built-in policy allows only POST, PUT and PATCH otherwise.
- **Other booking paths.** The whole-journal booking paths, VAT and webhooks stay
  denied by the built-in write policy; the booking tools are allowed only on
  their exact endpoint.

Every successful result has one text block: a short summary line (for example
`search_entities: 25 of 112 records from rest:customers. More pages are available.`),
a blank line, and then `structuredContent` serialized as compact JSON, as the
MCP specification recommends for tools that return structured content. Many
clients, Claude among them, read only the text block. The JSON is exactly
`structuredContent`: bank details, user data and other fields the gateway
removes are absent from both. Error results have only the text.

For review automation without live e-conomic credentials, set
`contractMode: true` when creating the gateway:

```ts
import { createEconomicGateway } from 'mcp-server-e-conomic/gateway';

const gateway = createEconomicGateway({ contractMode: true });
const result = await gateway.callTool('customer_overview', { number: 1001 });
```

A multi-tenant host:

```ts
const gateway = createEconomicGateway({ appSecretToken: process.env.APP_SECRET });
const result = await gateway.callTool('invoice_overview', { resource: 'invoices/overdue' }, {
  requestId,
  credentials: { agreementGrantToken: tokenForThisCompany },
});
```

Contract mode is deterministic, performs no network calls, and returns fixture
customers, products, accounts, company context, and pagination metadata. It
applies the same target checks as live mode. It is intended for review and
demo tests only; production connectors should use real e-conomic credentials
or e-conomic's documented `demo` tokens for live GET-only smoke tests.

### Installing without the npm registry

The package is not published to npm yet. To embed a pinned commit without
running its build on the consumer side, pack it once and install the tarball:

```sh
git clone https://github.com/borgels/mcp-server-e-conomic && cd mcp-server-e-conomic
git checkout <commit>
npm ci && npm pack            # prepack runs typecheck, tests and build
# in the consuming project:
npm install --ignore-scripts /path/to/mcp-server-e-conomic-<version>.tgz
```

The tarball contains `dist`, and the package has no install scripts, so the
consumer installs only the runtime dependencies.

## Verification

Run checks without real credentials:

```sh
npm run typecheck
npm test
npm run build
```

Run the optional live GET smoke test with demo or real credentials:

```sh
ECONOMIC_APP_SECRET_TOKEN="demo" ECONOMIC_AGREEMENT_GRANT_TOKEN="demo" npm run smoke:live
```

Call every read tool of `./gateway` on every target it may read against
e-conomic's public demo agreement (both tokens `demo`; the demo agreement has
the SuperUser role). It prints one line per call and never the data:

```sh
npm run check:demo
```

## API Sources

- REST docs: <https://restdocs.e-conomic.com/>
- OpenAPI docs: <https://apis.e-conomic.com/>
- Developer hub: <https://developer.visma.com/api/e-conomic>
- Authentication: <https://www.e-conomic.com/developer/authentication>

## License

Apache-2.0. See [LICENSE](LICENSE).
