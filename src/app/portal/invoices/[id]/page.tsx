import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireCustomerUser } from "@/lib/auth";
import { InvoiceView, loadInvoice } from "@/components/invoice-view";
import { PageHeader } from "@/components/ui";
import { PrintButton } from "@/components/print-button";

export default async function PortalInvoice({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCustomerUser();
  if (user.role !== "CUSTOMER_ADMIN") redirect("/portal");
  const invoice = await loadInvoice((await params).id);
  if (!invoice || invoice.customerId !== user.customer.id || invoice.status === "DRAFT" || invoice.status === "VOID") notFound();
  return (
    <>
      <PageHeader title={`Invoice ${invoice.number}`} actions={<><Link href="/portal/invoices" className="btn-secondary">Back</Link><PrintButton /></>} />
      <InvoiceView invoice={invoice} />
    </>
  );
}
