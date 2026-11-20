# Changelog

## 0.12.0

Quotes and orders in the embedded gateway (#64). Additive for embedders.

- Read tools `quote_overview` and `order_overview`: draft (default), sent or
  archived quotes and orders on the classic REST surface, or one document with
  its lines. Each reads only its own three collections.
- Write tools `create_draft_quote` and `create_draft_order`: a draft built
  exactly like `create_draft_invoice` (customer defaults, first layout, lines
  with a product each), posted to `/quotes/drafts` or `/orders/drafts`.
- Write tools `upgrade_quote` (`to`: `order` or `draftInvoice`) and
  `upgrade_order` (to a draft invoice): read e-conomic's upgrade template for
  the draft and post it, as e-conomic documents. The policy is checked before
  the template is read. Nothing is booked or sent.
- Log values (`change`): customer number, currency and date for the drafts,
  plus the line count; the quote or order number and the target for the
  upgrades. No names or free text.
- Not offered: sending a quote or order (`/quotes/sent`, `/orders/sent`) and
  deleting drafts. A test checks that the only quote and order write endpoints
  are the two draft POSTs.
- A read answer with more pages says "1 of 3 records", not "1 of 3 record".
- `npm run check:demo` prints only the summary line or the HTTP status, never
  an error body.

## 0.11.0

Embedded gateway: a fixed fence for a broad app role (SuperUser), #73.

- **Fence.** `GATEWAY_FENCE` (src/economic/fence.ts, exported from
  `./gateway`) lists requests the gateway never sends, whatever the host
  policy: every `DELETE` and `delete`/`deletebulk` path, writes to `/self`
  (company record, bank information, user, settings), any write with `bank`
  in the path, users, app roles, agreements and settings, webhooks, booking a
  whole journal (`/book`, `bookWithDateInterval`), accounting years and the
  chart of accounts. It is checked in the HTTP client right before `fetch`,
  on the path decoded and lower-cased. The standalone server does not use it.
- **Breaking:** `upsert_account` is always refused by the gateway (the chart
  of accounts is behind the fence), before any request and in contract mode
  too: a write tool whose every write is fenced is refused up front. Hosts
  that already disabled it see no change.
- **Breaking:** `additionalFields` is removed from `upsert_project`,
  `create_time_entry`, `upsert_supplier`, `upsert_employee` and
  `upsert_account`. Write tools accept only the fields in their schema;
  nothing is passed through. `upsert_supplier` gains `phone`. Bank fields are
  still refused first, with the bank message.
- The credential headers (`X-AppSecretToken`, `X-AgreementGrantToken`) are
  set after any headers given with a request, and a request that tries to
  give either (in any letter case) is refused before it is sent.
- Every gateway result, early refusals included, passes through the call's
  redactor (the call's token is registered before any check), so a token
  e-conomic echoes in an answer, or one given in the input, never reaches the
  caller. Structured content is redacted as data and the text block's JSON is
  written again from it, so it stays valid JSON equal to the structured
  content.
- Tests: each fenced path is refused before sending, every declared upstream
  request passes the fence and is a catalog endpoint, no tool takes a method,
  path or URL, every write schema is closed, and both tokens are redacted
  from errors and answers that repeat them.
## 0.10.3

The catalog uses the OpenAPI versions e-conomic publishes (apis.e-conomic.com,
read 20.11.2026), and two read targets that answered 404 are fixed (#72).

- journalsapi v15.0.0 -> v16.0.1, q2capi v5.1.0 -> v7.0.0, bookedEntriesapi
  v4.0.0 -> v7.0.0, documentsapi v3.0.1 -> v4.0.2, accountsapi v7.0.0 ->
  v7.0.1, dimensionsapi v5.3.0 -> v5.3.1, productsapi v2.0.0 -> v2.1.0,
  projectsapi v1.1.0 -> v1.1.1. The changelogs of these versions only add
  fields, error codes and endpoints, or correct documentation; no endpoint the
  server uses was removed or renamed. The old versions still answer and send no
  deprecation or sunset header.
- `accounting_entries` reads `booked-entries/matched-pairs` at
  `/booked-entries/matched-pairs`: the API has no `/paged` endpoint for it.
  The catalog marks such resources as `unpaged`.
- `product_overview` no longer offers `products:specialprices`. Special prices
  are not a top-level resource in productsapi; `/specialprices/paged` answered
  404 (#63).
- `npm run check:demo` calls every read tool of `./gateway` on every target it
  may read against e-conomic's public demo agreement (tokens `demo`), and
  prints one line per call, never the data. All targets answer with v0.10.3.

## 0.10.2

Fix: `product_overview` read products at a path that does not exist.

- Products in the OpenAPI products service (`productsapi/v2.0.0`) are paged
  at `/productspaged/paged`, as e-conomic's documentation for the products
  API lists. `/products/paged` answers 404 for every agreement, so
  `product_overview` failed on its default target (#61).
- The catalog now records a service's own page path where it differs from
  `/{resource}/paged` (`pagedPaths`), and the read resolution, the endpoint
  allowlist and the `upstream` list in `economicToolCatalog` all use it.
  `GET /products` and `GET /products/{number}` are unchanged.
- Checked with GET requests against e-conomic's demo agreement: products,
  product groups, price groups and sales prices in currencies all answer.

## 0.10.1

Embedded gateway: the data is now in the text block too. Fix for embedders
whose AI client reads only the text.

- Every successful `callTool` result has its `structuredContent` serialized
  as compact JSON in the text block, after the summary line and a blank
  line: `summary\n\n{...}`. Before, the text held only the summary, so a
  client that reads the text (as Claude does) got no data, for example only
  `company_context: company, agreement, modules and settings.`. The MCP
  specification says a tool that returns structured content should also
  return the serialized JSON in a text block.
- The JSON is exactly `structuredContent`, so the existing removal of bank
  details, user data and application tokens applies to the text as well.
- `structuredContent` and error results are unchanged. The result still has
  one text block. Code that compared the whole text with the summary should
  compare the first line (`text.split('\n\n')[0]`).
- The standalone server already returned the data as JSON text; unchanged.

## 0.10.0

Embedded gateway: booking, payments and journal entries, a host policy, and a
bank-detail guard. Additive for embedders.

- New write tools in `economicToolCatalog`: `create_journal_entries`
  (ledger lines and supplier invoices as one draft voucher in a journal),
  `register_payment` (a customer or supplier payment as a draft journal
  line), and the booking tools `book_journal_entries` (explicit draft
  entries, by entry or voucher numbers, with the standalone server's booking
  guardrails), `book_invoice` (`POST /invoices/booked` with
  `sendBy: none`) and `match_open_items`. One call is one change; the host
  logs before it calls, so there is no prepare/commit step in the embedding.
- Host policy: `createEconomicGateway({ policy: { enableWrites, allowBooking,
  disabledTools, allowedTools } })`. Booking is off unless `allowBooking`
  is set (and needs writes). Disabled or not-allowed tools are left out of
  `gateway.tools` and refused by `callTool`, also in contract mode.
  Unknown tool names and contradictions throw at creation.
  `gateway.policy` is the resolved policy.
- Catalog entries gain `booking` and, for write tools,
  `change: { action, record, logFields }`, where each log field has one
  type (record number, number list, amount, quantity, date, currency,
  accounting year, enum). New `resolveEconomicChange(tool, input)` returns
  only values of the right type, so names and free text never reach a log.
- Contract mode refuses write tools while writes are off, as live mode does
  (it used to answer with a fixture). Contract-mode hosts that write pass
  `enableWrites`.
- Raw endpoint calls in the standalone server are canonicalised against the
  catalog before any policy or bank check (a template without the leading
  `/` named the same endpoint but slipped past slash-led patterns), and
  `checkPolicy` adds a missing leading `/` itself.
- Bank details are never changed: bank fields (`bankAccount`,
  `remittanceAdvice`, `paymentDetails`, `bankInformation`, IBAN,
  SWIFT/BIC, giro, registration number) are refused in gateway write input and
  bodies, and a supplier update is refused if its bank details would change.
  The standalone server's `economic_call_endpoint` and
  `economic_commit_prepared_operation` apply the same guard. The built-in
  write policy denies writes to `/self`.
- Booking reads the journal's draft entries to the end (at most
  `MAX_DRAFT_PAGES`, 200 pages) and refuses to book when the list does not
  end within the cap, in the gateway and the standalone server alike; it used
  to stop silently after ten pages and could book part of a voucher.
- Currency is an ISO 4217 code written in capitals (`DKK`), in the tool
  input and in the log values; lower case and three-letter words that are not
  codes are refused.
- `validateBooking` takes the amount limit as an argument when called from
  the gateway, so the gateway never reads `ECONOMIC_POLICY_PATH`.
- Catalog: `POST /journals/{journalNumber}/vouchers` (REST, draft) and
  `POST /invoices/booked` (REST, dangerous).

## 0.9.0

Embedded gateway (`mcp-server-e-conomic/gateway`): fixed read targets per tool,
catalog export, and per-call credentials. Breaking for embedders; the
standalone stdio/HTTP server is unchanged.

- Each narrow read tool reads only a fixed list of `{ serviceId, resource }`
  targets that matches its name and description, enforced before any request
  is sent (also in contract mode). `serviceId` and `resource` are enums in the
  input schema; unknown input fields are refused. `get_entity` is the one broad
  tool (any read endpoint in the catalog) and says so in its title and
  description. `report_data` no longer reads booked entries (use
  `accounting_entries`), and `search_entities` lists master data only.
- New exports, in the server family's shape: `economicToolCatalog` (frozen
  `GatewayToolCatalogEntry[]`; per tool `upstream` with every request it may
  make, plus the e-conomic additions `broad` and `defaultRead`), the
  `EconomicGateway` type, `economicServiceCatalog` (frozen; services,
  resources, endpoints with read/write marking) and
  `resolveEconomicReadTarget(tool, input)`. A test checks that every request a
  tool makes is declared in its `upstream`.
- `EconomicClient` takes `credentialEnv` (where omitted credentials, base URLs
  and timeout are read from; default `process.env`); the gateway passes `{}`.
- `callTool(name, input, context?)` with
  `{ caller?, requestId?, credentials?: { agreementGrantToken } }`.
- The embedded gateway never reads `ECONOMIC_*` environment variables.
  `appSecretToken` is required at creation outside contract mode; the
  agreement grant token comes from the call context or the options. Writes
  are enabled only by `enableWrites`. A blank or whitespace-only token counts
  as missing.
- With writes off, write tools are refused before any request (they used to
  send their preparatory reads first).
- Token redaction uses a `SecretRedactor` per gateway instance (and per call),
  instead of the module-global set; the standalone server keeps a process-wide
  redactor for its environment tokens.
- The `search_entities` and `supplier_overview` defaults read `/customers` and
  `/suppliers` (they built a REST `/paged` path the allowlist refused).
- Results carry a short summary text next to `structuredContent`.
- `company_context` returns only company name, address, CVR/VAT number,
  agreement number and type, modules and settings, not bank details, user
  data or the app's tokens. `check_connection` returns `{ connected: true }`
  (also in contract mode).

### Upgrade notes (embedders)

- Pass `appSecretToken` to `createEconomicGateway`; pass the agreement grant
  token per call in `context.credentials` (or once in the options for a
  single-tenant host). `ECONOMIC_APP_SECRET_TOKEN`,
  `ECONOMIC_AGREEMENT_GRANT_TOKEN`, `ECONOMIC_BASE_URL_*`,
  `ECONOMIC_TIMEOUT_MS`, `ECONOMIC_ENABLE_WRITES` and `ECONOMIC_POLICY_PATH`
  no longer affect the gateway.
- `callTool` no longer throws on upstream or validation errors; it returns an
  `isError` result with a redacted message.
- Inputs that named a `serviceId`/`resource` outside a tool's list, or a
  `selfUrl` on a tool other than `get_entity`, are now refused.

## 0.8.0

HTTP transport, upstream client and supply chain.

- HTTP transport fails closed: it refuses to start on a non-loopback bind, or
  with `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit escape hatch.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters without
  whitespace.
- Failed authentication is limited per client address (429 with
  `Retry-After`; `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`).
  Requests with a valid token are never throttled.
- `Host` header check on loopback binds (`MCP_ALLOWED_HOSTS` to override).
- 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON gets 400
  instead of 500; oversized bodies get 413 before they are read.
- `GET /healthz` (unauthenticated) and graceful shutdown on SIGTERM/SIGINT.
- `PORT`, `MCP_MAX_BODY_BYTES` and boolean flags are validated at startup.
- CI runs on pull requests and before every image publish; images are only
  published from `main` and `v*` tags, with SBOM and provenance attestations.
  GitHub Actions are pinned to commit SHAs.
- Dependency updates; `npm audit --omit=dev` is clean.
- Upstream requests no longer follow redirects, so the `X-AppSecretToken` and
  `X-AgreementGrantToken` headers are never resent to a redirect target; a
  redirect is reported as an error. Upstream error bodies are read up to
  64 KB, and the configured token values are redacted from error messages by
  value (the most recent 100 values are kept). Error messages returned to
  clients are capped at 500 characters after redaction; the full payload
  stays on `EconomicHttpError.payload`.
- `ECONOMIC_TIMEOUT_MS` is validated (1-600000) instead of becoming `NaN`.
- The server reports the package version.
- Contract-mode fixtures and gateway docs use neutral names.

### Upgrade notes

- A deployment that binds a non-loopback address (for example `0.0.0.0` in a
  container) now needs `MCP_HTTP_TOKEN` of at least 32 characters, or the
  server exits at startup. A 64-character hex token (`openssl rand -hex 32`)
  works unchanged.
- Shorter tokens, tokens with whitespace or a trailing newline, and
  non-numeric or out-of-range numeric settings are rejected at startup.
- New optional variables: `MCP_HTTP_ALLOW_UNAUTHENTICATED`,
  `MCP_ALLOWED_HOSTS`, `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`.
- `ECONOMIC_TIMEOUT_MS` must be an integer between 1 and 600000.

Also in this release:


Security hardening:

- Prepared operations are now signed with HMAC-SHA256 using a server secret
  (`ECONOMIC_PREPARE_SECRET`, or a random per-process secret when unset) and
  expire after 15 minutes. Operations prepared by earlier versions must be
  prepared again.
- Booking / open-item match commits re-run all booking guardrails (entries,
  `maxAmount`, vouchers) and require a digits-only `journalNumber`.
- Each write capability is bound to a fixed set of endpoints, enforced at
  prepare and commit; prepare tools no longer accept arbitrary endpoints.
- `selfUrl` must be `https:` on the default port and is resolved to an
  allowlisted read endpoint before it is called.
- Caller-supplied URL path parameters reject empty/dot segments, separators,
  `?`, `#`, and encoded dots/slashes.
- HTTP transport: constant-time Bearer token comparison; refuses to start when
  a `*_TRUST_FORWARDED_USER=true` setting is present without `MCP_HTTP_TOKEN`.
- Linear-time trailing-slash trimming for configured base URLs.

## 0.7.0 (2026-07-15)

Conditional booking (booking duty) — booking stays denied by default:

- `economic_prepare_booking`: validate and prepare booking of EXPLICIT journal
  draft entries via journalsapi v15 `bookdraftentries`. Guardrails: entries
  must exist in the journal, per-entry amounts run the policy maxAmount
  check, and every referenced voucher must have an attached document.
- `economic_prepare_open_item_match`: prepare udligning of booked
  customer/supplier open items (no API undo exists).
- `economic_commit_booking`: the only executor for the two capabilities above;
  the ordinary commit tool rejects them (lets a gateway enforce a separate
  booking duty per tool name). Requires `ECONOMIC_ENABLE_BOOKING=true`.
- Journals service bumped to v15.0.0.

## 0.6.0 (2026-07-15)

- New `economic_prepare_supplier_change` tool (supplier master records via
  classic REST `/suppliers`).
- Default policy now denies `POST /invoices/booked` (classic REST invoice
  booking) — booking was already denied for journals; invoices are now
  consistently draft-only unless a custom policy explicitly allows booking.

## 0.5.1 (2026-07-14)

- `economic_get_company_context` (and the gateway `company_context` tool) now
  calls `GET /self` and returns the agreement's own context — company name,
  CVR, agreement number, modules, settings — instead of the anonymous REST
  root document. Use it to confirm which agreement the server is connected to.

## Unreleased

## 0.5.0

- Added `upsert_account` (risk `destructive`, disabled by default): create a
  general-ledger account via `POST /accounts`, or update by `accountNumber` via
  read-merge-write `PUT /accounts/{number}`. Editing the chart of accounts is a
  structural change, so a hosting control plane should gate it behind approval.
  Policy-gated; covered by live-path, negative-path, and contract-mode tests.

## 0.4.0

- Added supplier and project-employee write tools (risk `write`, disabled by
  default): `upsert_supplier` (classic REST: create `POST /suppliers`, update by
  `supplierNumber` via read-merge-write `PUT /suppliers/{number}`) and
  `upsert_employee` (Projects add-on collection upsert like `upsert_project`).
  Both policy-gated; covered by live-path, negative-path, and contract-mode tests.
- Allowlisted the classic REST supplier write endpoints (`POST /suppliers`,
  `PUT /suppliers/{number}`).

## 0.3.0

- Added gateway read tools for the newer OpenAPI services: `project_overview`
  (Projects add-on: Projects/ProjectGroups/CostTypes/Activities/Employees/
  TimeEntries via the `resource` param, default Projects) and `accounting_entries`
  (booked entries by default; journal draft entries via serviceId/resource). Both
  default OpenAPI-first (`apis.e-conomic.com`) and are enabled by default.
- Added project write tools (risk `write`, disabled by default): `upsert_project`
  (create via `POST /Projects`, update by `projectNumber` via read-merge-write
  collection `PUT /Projects` preserving `objectVersion`) and `create_time_entry`
  (register hours via `POST /TimeEntries`; create only). Both are policy-gated and
  covered by live-path, negative-path, and contract-mode tests.
- Generalized the gateway write-policy check to carry the OpenAPI `serviceId` so
  project writes are governed on the correct surface.

## 0.2.0

- Added an `enableWrites` gateway option: a
  hosting control plane that applies its own write governance opts in
  programmatically instead of via the standalone `ECONOMIC_ENABLE_WRITES` env
  flag. The rest of the write policy (denied paths, max amount) still applies.
- BREAKING: the `create_draft_invoice` gateway tool now enforces the write
  policy. Embedders must pass `enableWrites: true` (or set
  `ECONOMIC_ENABLE_WRITES=true`) for it to execute; previously it ran ungated.
- Added `upsert_customer` and `upsert_product` gateway tools (risk `write`,
  disabled by default). Customers create via `POST /customers` and update by
  `customerNumber` via read-merge-write `PUT /customers/{number}`; products use
  the `productNumber` key to decide create vs update. Both are policy-gated and
  covered by live-path, negative-path, and contract-mode tests.
- Allowlisted the REST customer/product write endpoints (`POST /customers`,
  `PUT /customers/{number}`, `POST /products`, `PUT /products/{number}`).

## 0.1.4

- Added Projects (Projektregnskab) add-on tools: `economic_prepare_project_change`,
  `economic_prepare_project_group_change`, `economic_prepare_employee_change`, and
  `economic_prepare_time_entry`. These model the e-conomic upsert pattern — create
  via `POST /X`, update via `PUT /X` (the full object including its number and
  `objectVersion`; a full replace), delete via `DELETE /X/{number}`. Item-level
  `PUT /X/{number}` and `PATCH` are unsupported by the API (HTTP 405).
- Allowlisted collection-level `PUT /{resource}` for OpenAPI services to reflect
  e-conomic's create-or-update-via-collection behavior, alongside the existing
  item-level operations.
- Added read coverage for project master data managed in the e-conomic UI:
  `CostTypes`, `ProjectStatuses`, `ActivityGroups` (plus `TimeEntries` and
  `Activities`) on the `projects` service.
- Added `economic_attach_sales_invoice_file` to upload a PDF/file attachment to a
  draft sales invoice via multipart `POST /invoices/drafts/{n}/attachment/file`.
- Added `POST /accounts` and `PUT /accounts/{number}` plus extra REST read
  resources (currencies, departments, employees, layouts, payment-terms, units,
  departmental-distributions); fixed the REST single-item GET path to `/{number}`.
- Added a `create_draft_invoice` gateway tool (risk `write`, disabled by default)
  that creates a draft (unbooked, unsent) sales invoice via
  `POST /invoices/drafts`. Currency, payment terms, VAT zone, recipient name, and
  layout default from the customer when not supplied; each line requires a product
  reference (an e-conomic validation requirement). Supports an idempotency key.
  Draft creation does not book or send anything. Covered by contract-mode and
  live-path gateway tests and exercised against a live demo agreement.

## 0.1.3

- Added `economic_attach_voucher_file` tool that uploads a binary attachment
  (typically a PDF) to an existing voucher in a daybook journal via
  `PUT /journals/{n}/vouchers/{ay}-{vn}/attachment/file`. Runs through the
  same policy and audit pipeline as other mutating tools and requires an
  idempotency key.
- Extended `EconomicClient` with `restRawBody()` and a `rawBody`/`rawContentType`
  pair on `request()` so non-JSON request bodies are first-class. `request()`
  now refuses to send a payload that sets both `body` and `rawBody`.

## 0.1.2

- Added Apache-2.0 `LICENSE` file and package metadata.
- Added `SECURITY.md` with the project security contact.
- Added GitHub Actions CI and Dependabot configuration.
- Hardened the Streamable HTTP transport with loopback default binding,
  optional bearer token, configurable CORS allowlist, 10 MiB default
  request-body cap, and explicit override for controlled deployments.
- Added package publish allowlist and `prepack` build guard.
- Refused non-HTTPS e-conomic base URLs except loopback mocks.
- Added transitive dependency overrides for MCP HTTP transport security alerts.
- Updated `zod`, `vitest`, and `@types/node` to current compatible releases.

## 0.1.1

- Added `npm run auth:grant` to capture an e-conomic Agreement Grant Token from
  the documented installation redirect flow.
- Documented the App Secret Token, App Public Token, and Agreement Grant Token
  setup path for users onboarding a real e-conomic agreement.
- Added `ECONOMIC_APP_PUBLIC_TOKEN` and `ECONOMIC_INSTALLATION_URL` examples for
  credential onboarding.

## 0.1.0

- Initial private e-conomic MCP server.
- Added read-first e-conomic client for REST and OpenAPI endpoints.
- Added capability discovery, schema summaries, and allowlisted endpoint calls.
- Added prepared-operation write flow with policy checks, idempotency, and audit logging.
