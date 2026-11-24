import { describe, expect, it } from "vitest";
import { isQuietRun, summarizeRun } from "@/lib/services/automation-plan";

describe("summarizeRun", () => {
  it("describes what a run did in plain English", () => {
    expect(
      summarizeRun({
        housekeeping: { noShows: 1, autoCheckedOut: 0, approvalsExpired: 2 },
        monthEndClose: { period: "2026-10", created: 3, regenerated: 0, skipped: 0, failed: 0 },
        invoiceLifecycle: { issued: 1, reminders: 2, lateFees: 0, suspended: 0 },
      }),
    ).toBe("1 no-show recorded · 2 approval requests expired · 3 draft invoices created · 1 invoice issued · 2 reminders sent");
  });
  it("recognises quiet runs", () => {
    const quiet = { housekeeping: { noShows: 0 }, monthEndClose: { skipped: 3 }, invoiceLifecycle: { issued: 0 } };
    expect(summarizeRun(quiet)).toBe("Nothing was due");
    expect(isQuietRun(quiet)).toBe(true);
  });
  it("reports failed steps", () => {
    expect(summarizeRun({ invoiceLifecycle: { error: "boom" } })).toBe("errors in invoiceLifecycle");
  });
});
