# LabShare: product specification

## The idea

A building operator owns a facility full of lab equipment. About 100 research companies have no labs of their own. Their staff rent time on the operator's instruments, and some companies also rent an office suite in the building. The operator needs one platform where:

1. **Customers** (research companies and their employees) find equipment they are allowed to use, see when it is free, and book time.
2. **The facility** controls *who can use what*, runs day-to-day operations (approvals, no-shows, maintenance) and reviews usage.
3. **Billing runs by itself.** At month end, usage becomes invoices. The invoices go out, reminders follow, and the money gets reconciled, with a human stepping in only where judgement is needed.

## Roles

| Role | Who | Can |
|---|---|---|
| Facility admin | Building owner / finance | Everything: customers, plans, pricing, equipment, settings, usage review, invoices, payments |
| Facility staff | Lab managers / technicians | Approve bookings, mark no-shows, schedule maintenance, certify users. No commercial settings. |
| Customer admin | Lab lead / ops at a research company | Book; see the whole organisation's bookings, usage and invoices; manage their team |
| Customer member | Scientist | Book equipment they're cleared for, check in and out, cancel |

## Access control ("what kind of customer can rent what")

Access is decided in layers. All of them must pass. The rules live in `src/lib/domain/booking-rules.ts`.

1. **Account status.** Only `ACTIVE` customers can book. `PENDING` (not yet onboarded), `SUSPENDED` (manually, or automatically for overdue invoices) and `CLOSED` cannot.
2. **Plan level.** Each customer is on a plan (tier) with a *level*, and each instrument has a *minimum level*. For example, Starter (1) gets core equipment, Professional (2) adds advanced imaging, and Enterprise (3) gets everything.
3. **Restricted equipment.** Some instruments ignore plans entirely and need an explicit per-customer **grant** (for example LC-MS/MS). Grants can also lift a customer above its plan for one instrument.
4. **User certification.** Instruments can require training. Each *person* needs a certification granted by staff, optionally with an expiry date.
5. **Approval.** Instruments can require staff approval. Bookings start as requests and expire if nobody answers before they start.
6. **Scheduling rules.** Bookings must sit on slot boundaries (15 min by default) and respect the instrument's min/max duration and bookable hours (in the facility's time zone). They can be made at most N days ahead, must keep cleanup buffer time between bookings, and can't overlap maintenance windows.
7. **Monthly hour quota** (optional, per customer).
8. **No double booking.** This is checked in a serializable transaction *and* guaranteed by a Postgres exclusion constraint, so it holds even under simultaneous clicks.

## Pricing and what is billable

- Every instrument has a list **hourly rate**. A customer can have a **negotiated rate** per instrument. The rate is *captured on the booking* when it is made, so later price changes never alter past usage.
- The customer's **plan discount %** applies to usage-based lines on the invoice.
- **Billable time = actual use (check-in → check-out), but never less than the booked slot.** It is rounded up to the instrument's billing increment (15 min by default). Overruns are billed at actual time and flagged.
- **No-show** (not checked in within the grace period): charged at the no-show % of the booked slot (default 100%).
- **Late cancellation** (inside the window, default 24 h): charged at the late-cancel % (default 50%). Cancelling earlier is free.
- Facility-initiated cancellations and waived no-shows are never charged.
- **Office rent**: a fixed monthly line for customers with a suite.
- **Adjustments**: free-form credits and charges added during review, such as downtime credits or consumables.
- **Tax** at the facility rate on the discounted subtotal.

The billing engine (`src/lib/domain/billing.ts`) is one pure function. The usage review screen and the persisted invoice both call it, so **what the facility reviews is exactly what gets invoiced.**

## The automated billing cycle

`runAutomation()` (`src/lib/services/jobs.ts`) runs hourly. Every step is idempotent.

```
during the month  ─ housekeeping ─ no-shows · auto check-out of forgotten sessions (flagged) · expire stale approval requests
1st of the month  ─ month-end close ─ draft invoice per customer for last month
                    (late-closed bookings from earlier months roll into the next invoice, so nothing is lost)
review window     ─ admin reviews drafts on Usage review; fixes times from instrument logs, adds credits, clicks Recalculate
issue             ─ clean drafts are issued immediately (if enabled); drafts with warnings wait for review
                    and are issued automatically after N days. Issuing emails the invoice and sets the due date.
before due        ─ one "upcoming" reminder
after due         ─ overdue reminders every N days · one-time late fee added to the next invoice
N days overdue    ─ booking access auto-suspended (customer is emailed)
payment recorded  ─ partial or full; receipt emailed; when nothing is overdue any more, access is restored automatically
```

Every rule has a switch or threshold under **Admin → Settings**. Every run is logged under **Admin → Automation**, along with every email that was sent.

**Payments** are recorded by the facility (bank transfer, cheque, card terminal, cash). There is no online payment collection in this version; see the roadmap.

## Data model (summary)

`FacilitySettings` · `PricingTier` · `Customer` · `User` · `EquipmentCategory` · `Equipment` · `EquipmentGrant` · `CustomerEquipmentRate` · `UserCertification` · `MaintenanceWindow` · `Booking` · `BillingAdjustment` · `Invoice` · `InvoiceLine` · `Payment` · `JobRun` · `EmailLog` · `AuditLog`. See `prisma/schema.prisma`.

Money is stored as integer cents and times in UTC. Billing months and opening hours use the facility time zone.

## Roadmap (not built yet)

- Online payments: card/ACH through a payment provider, with saved payment methods and autopay
- Accounting export (QuickBooks/Xero) and CSV exports
- Customer self-signup with facility approval; SSO
- Calendar (ICS) feeds and a week view; recurring bookings; waitlists
- Instrument integrations (interlocks or instrument PCs that check users in and out automatically)
- Consumables and services catalogue (billable items per booking)
- Per-equipment peak/off-peak pricing; prepaid hour bundles
- PDF invoice attachments (currently print-to-PDF from the browser)
- Multi-facility / multi-building support
