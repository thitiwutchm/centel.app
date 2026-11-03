# Billing API (owner's B2B billing)

Centel's owner uses this to bill the companies they build apps for: keep a list of
clients, set up repeating charges (billing day, due days, start/end), issue invoices
with one tap, record payments, and check who has paid. The back office is at
**https://centel.app/billing/** (also linked from the app: บัญชี › งานของฉัน › Billing คู่ค้า).

Code: `server/src/billing.js`, tables in `server/migrations/024_billing.sql`,
pages in `billing/`. Tests: `server/test/billing.test.js`.

## Who can use it

- Signed in to Centel as an owner: the emails in the api's `BILLING_ADMINS`
  variable (comma separated). If the variable is not set, only the oldest account on
  the server can (the owner's own).
- Another system: an API key made in /billing/ › ตั้งค่า, sent as
  `Authorization: Bearer cbk_...`. Keys can do everything except make or revoke keys.
  Requests with a key need no CSRF header; cookie requests need `X-Centel: 1` on writes.

All routes are under `/api/billing`. Dates are Bangkok dates `YYYY-MM-DD`. Money is a
number with two decimals. Errors are `{ "error": "<code>" }` with a 4xx status.

## "Has company A paid?"

```
GET /api/billing/clients/A/status
```

`A` is the client's id or its short `code`. Answer:

```json
{
  "client": { "id": "…", "code": "A", "name": "บริษัท เอ ดิจิทัล จำกัด" },
  "today": "2026-11-03",
  "paidUp": false,
  "outstanding": 15600,
  "overdueAmount": 15600,
  "overdueCount": 1,
  "openCount": 1,
  "nextDue": "2026-10-16",
  "lastPayment": { "paidOn": "2026-09-12", "amount": 15600 },
  "nextBillDate": "2026-11-01",
  "unpaid": [ { "id": "…", "number": "KB-2026-0002", "state": "overdue", "balance": 15600, "dueDate": "2026-10-16", "…": "…" } ]
}
```

## Routes

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/me` | Checks access; `{ admin, via: "session" \| "api_key", today }` |
| GET | `/summary` | Totals owed / overdue / paid this month, every client's status, plans due in 31 days |
| GET, PUT | `/settings` | Seller name, tax id, address, bank info, `invoicePrefix`, `defaultDueDays`, `vatRate`, `remindDays`, `footerNote` |
| GET | `/clients` | Clients with status (`?archived=1` includes archived) |
| POST | `/clients` | `{ name, code?, contactName?, email?, phone?, taxId?, address?, notes?, dueDays? }` |
| GET | `/clients/{id or code}` | Client, status, plans and invoices |
| GET | `/clients/{id or code}/status` | The answer above |
| PUT | `/clients/{id or code}` | Same fields as POST, plus `archived` |
| POST | `/clients/{id or code}/link` | New link for the client's page (the old one stops working) |
| DELETE | `/clients/{id or code}` | Only when nothing was issued yet (`client_has_invoices` otherwise; archive instead) |
| GET | `/plans?clientId=` | Plans |
| POST | `/plans` | `{ clientId, name, amount, currency?, every: "month"\|"year"\|"once", billDay (1–31), dueDays?, vat?, whtRate?, startDate, endDate?, autoIssue? }` |
| PUT | `/plans/{id}` | Same fields, plus `active` and `nextBillDate` (move the next run) |
| DELETE | `/plans/{id}` | Issued invoices stay |
| POST | `/plans/{id}/issue` | **One tap:** issue the plan's next run now (`{ issueDate? }`), moves the plan on |
| GET | `/invoices` | `?clientId=&status=unpaid\|overdue\|draft\|issued\|paid\|void&from=&to=&limit=` |
| POST | `/invoices` | One-off: `{ clientId, items: [{ description, qty, unitPrice }], vatRate? or vat: true, whtRate?, issueDate?, dueDate?, notes?, issue: true }` (without `issue` it stays a draft) |
| GET | `/invoices/{id}` | Invoice with payments |
| PUT | `/invoices/{id}` | Change items, rates, dates, notes |
| POST | `/invoices/{id}/issue` | Draft → issued: gets its number and due date |
| POST | `/invoices/{id}/void` | Cancel an issued invoice (its number is not reused) |
| DELETE | `/invoices/{id}` | Drafts only |
| POST | `/invoices/{id}/payments` | `{ amount?, paidOn?, method?, reference?, note? }`; no amount = the whole balance |
| DELETE | `/invoices/{id}/payments/{paymentId}` | Undo a payment |
| GET, POST, DELETE | `/keys`, `/keys/{id}` | API keys (signed-in owner only); the key is shown once |

### Invoice fields

`status` is what is stored: `draft`, `issued`, `paid`, `void`. `state` is for showing:
the same, plus `partial` (some paid) and `overdue` (issued, past `dueDate`, balance left).
`total = subtotal + vat − wht` (VAT on top, withholding tax taken off what the client
transfers). Numbers look like `{prefix}-{year}-{0001}` and count per calendar year.

### Dates on a plan

- `billDay`: the day of the month the bill goes out; a shorter month uses its last day.
- `nextBillDate`: the next run. Issuing (by tap or automatically) moves it a month
  (or a year) on; past `endDate`, or for `once`, the plan finishes.
- Due date = issue date + plan `dueDays`, else client `dueDays`, else settings `defaultDueDays`.
- `autoIssue`: the api checks every 10 minutes and issues runs that are due, one run
  per plan per check, and the owner gets an iPhone notification (Centel push).
- Owner reminders: `remindDays` before the due date, and once when it goes overdue.
- One invoice per plan per period (a double tap gets `already_issued`).

## Client links (no sign-in)

- `/billing/invoice.html?i={publicToken}`: one invoice, printable / save as PDF.
  Data from `GET /api/billing/public/invoice/{token}`.
- `/billing/invoice.html?c={portalToken}`: the client's page, what they still owe and
  every invoice. Data from `GET /api/billing/public/client/{token}`.

Drafts are never shown on these links.
