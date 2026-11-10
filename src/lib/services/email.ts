import { prisma } from "../db";

export interface Email {
  to: string[];
  subject: string;
  body: string;
  kind: string;
  relatedId?: string;
}

/**
 * Sends an email via Resend when RESEND_API_KEY is configured; otherwise logs it.
 * Every email is recorded in EmailLog so the facility can audit what customers were told.
 */
export async function sendEmail(email: Email): Promise<void> {
  const to = [...new Set(email.to.filter(Boolean))];
  if (!to.length) return;
  let status = "logged";
  const key = process.env.RESEND_API_KEY;
  if (key) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.EMAIL_FROM ?? "LabShare <billing@example.com>", to, subject: email.subject, text: email.body }),
      });
      status = res.ok ? "sent" : `failed:${res.status}`;
    } catch (e) {
      status = `failed:${(e as Error).message}`;
    }
  } else if (process.env.NODE_ENV !== "test") {
    console.log(`[email:${email.kind}] to=${to.join(",")} subject="${email.subject}"`);
  }
  await prisma.emailLog.create({
    data: { to: to.join(", "), subject: email.subject, body: email.body, kind: email.kind, relatedId: email.relatedId, status },
  });
}
