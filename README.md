# LabShare

A platform for a shared lab facility. Research companies book time on the facility's equipment under access rules the facility controls. Every month, usage is reviewed and invoiced automatically, then followed up with reminders, late fees and suspension until the money is reconciled.

See **[docs/SPEC.md](docs/SPEC.md)** for the full product specification: roles, access control, pricing rules and the automated billing cycle.

## Features

**Customer portal** (`/portal`)
- Equipment catalogue showing which instruments you're allowed to book, and why not otherwise
- Day timeline of availability and slot booking, with approval requests where required
- Check-in / check-out, and cancellation with late-fee warnings
- Live month-to-date usage, invoices (printable), team management

**Facility admin** (`/admin`)
- Overview: utilisation, pending approvals, the next 24 h, overdue receivables
- Bookings: approve or decline, mark no-shows, waive fees
- Customers: plans, office rent, quotas, payment terms, equipment grants, negotiated rates, user certifications
- Equipment: rates, billing increments, booking limits, bookable hours, cleanup buffers, access rules, maintenance windows
- **Usage review**: per-customer statement preview, correction of actual times, credits and charges
- **Invoices**: generate, review, issue and email, record payments, void
- **Automation**: rules in effect, run log, full email log
- Settings: tax, booking policy, every invoicing automation threshold

## Tech

Next.js 15 (App Router, server actions) · TypeScript · Prisma 6 · PostgreSQL 16 · Tailwind CSS 4 · Vitest.

## Run locally

```bash
cp .env.example .env              # set DATABASE_URL, SESSION_SECRET, CRON_SECRET
npm install
npx prisma migrate deploy
npm run db:seed                   # demo facility, 3 customers, last month's usage
npm run dev
```

Demo logins (password `password123`):

| Email | Role |
|---|---|
| admin@facility.test | Facility admin |
| staff@facility.test | Facility staff |
| lead@helixbio.test | Customer admin (Enterprise plan) |
| scientist@helixbio.test | Customer member (certified on imaging) |
| scientist@novatx.test | Customer member (Professional plan) |
| scientist@picodx.test | Customer member (Starter plan) |

Or with Docker (app, Postgres and an hourly scheduler):

```bash
docker compose up -d --build
```

## Automation

All automation runs from one idempotent endpoint. Call it at least hourly:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-host/api/cron/run
```

It is already wired up for:
- **Vercel**: `vercel.json` cron (sends the header automatically when `CRON_SECRET` is set)
- **Docker Compose**: the `scheduler` service
- **GitHub Actions**: `.github/workflows/automation.yml` (set repository secrets `APP_URL` and `CRON_SECRET`)
- **CLI**: `npm run jobs:run`

Emails are sent through [Resend](https://resend.com) when `RESEND_API_KEY` is set. Otherwise they are logged, and every email is always recorded under Admin → Automation.

## Tests

```bash
npm test                                                     # unit tests: booking rules, billing engine, dunning schedule
TEST_DATABASE_URL=postgresql://…/labshare_test npm test      # + end-to-end billing cycle against Postgres
```

The integration test only runs against a database whose name ends in `_test`, and it wipes that database.

## Project layout

```
prisma/schema.prisma            data model (+ migrations, seed)
src/lib/domain/                 pure business rules — booking-rules, billing, invoice-automation, time
src/lib/services/               database-backed operations — bookings, invoicing, jobs (automation), email
src/app/portal/                 customer portal
src/app/admin/                  facility admin
src/app/api/cron/run/           automation endpoint
tests/                          unit + integration tests
```
