import type { Statement } from "@/lib/domain/billing";
import { money } from "@/lib/format";
import { Badge } from "./ui";

export function StatementTable({ statement, currency }: { statement: Statement; currency: string }) {
  const m = (c: number) => money(c, currency);
  return (
    <>
      {statement.warnings.length > 0 && (
        <ul className="notice-problem mb-3 space-y-1 text-xs">
          {statement.warnings.map((w) => <li key={w}>Check: {w}</li>)}
        </ul>
      )}
      <table className="table">
        <thead><tr><th>Item</th><th className="text-right">Qty / hrs</th><th className="text-right">Rate</th><th className="text-right">Amount</th></tr></thead>
        <tbody>
          {statement.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.description}
                {l.flags?.filter((f) => f !== "overrun").map((f) => <span key={f} className="ml-1"><Badge tone="attention">{f}</Badge></span>)}
              </td>
              <td className="text-right tabular-nums">{l.quantity}</td>
              <td className="text-right tabular-nums">{m(l.unitCents)}</td>
              <td className="text-right tabular-nums">{m(l.amountCents)}</td>
            </tr>
          ))}
          {statement.lines.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-deep-blue">No billable usage.</td></tr>}
        </tbody>
        <tfoot className="text-sm">
          <tr><td colSpan={3} className="text-right">Subtotal</td><td className="text-right tabular-nums">{m(statement.subtotalCents)}</td></tr>
          {statement.discountCents > 0 && <tr><td colSpan={3} className="text-right">Plan discount</td><td className="text-right tabular-nums">−{m(statement.discountCents)}</td></tr>}
          <tr><td colSpan={3} className="text-right">Tax</td><td className="text-right tabular-nums">{m(statement.taxCents)}</td></tr>
          <tr className="font-semibold"><td colSpan={3} className="text-right">Total</td><td className="text-right tabular-nums">{m(statement.totalCents)}</td></tr>
        </tfoot>
      </table>
    </>
  );
}

export function PeriodPicker({ period, base }: { period: string; base: string }) {
  return (
    <form action={base} className="flex items-center gap-2">
      <input className="input w-40" type="month" name="period" defaultValue={period} />
      <button className="btn-secondary">Show</button>
    </form>
  );
}
