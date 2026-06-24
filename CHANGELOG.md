# Changelog

## Unreleased

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
