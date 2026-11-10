/* Demo data: a facility, three tiers, equipment with different access rules, three customer companies. */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const HOUR = 3600000;

async function main() {
  const pw = await bcrypt.hash("password123", 10);

  await prisma.facilitySettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, facilityName: "Riverside Research Labs", timezone: "America/New_York", taxRatePercent: 8.875, lateFeePercent: 1.5 },
  });

  const tiers = await Promise.all(
    [
      { name: "Starter", level: 1, discountPercent: 0, description: "Core equipment, pay as you go" },
      { name: "Professional", level: 2, discountPercent: 10, description: "Advanced instruments, 10% off usage" },
      { name: "Enterprise", level: 3, discountPercent: 20, description: "All instruments, 20% off usage" },
    ].map((t) => prisma.pricingTier.upsert({ where: { name: t.name }, update: {}, create: t })),
  );
  const [starter, pro, ent] = tiers;

  const cat = async (name: string) => prisma.equipmentCategory.upsert({ where: { name }, update: {}, create: { name } });
  const imaging = await cat("Imaging");
  const analytical = await cat("Analytical chemistry");
  const bio = await cat("Cell & molecular biology");

  const eq = async (data: Parameters<typeof prisma.equipment.create>[0]["data"] & { assetTag: string }) =>
    prisma.equipment.upsert({ where: { assetTag: data.assetTag }, update: {}, create: data });

  const pcr = await eq({ assetTag: "BIO-001", name: "qPCR System", categoryId: bio.id, hourlyRateCents: 4500, location: "Lab 1.02", minBookingMinutes: 30, maxBookingMinutes: 240 });
  const hood = await eq({ assetTag: "BIO-002", name: "Biosafety Cabinet (Class II)", categoryId: bio.id, hourlyRateCents: 2500, location: "Lab 1.04", bufferMinutes: 15 });
  const flow = await eq({ assetTag: "BIO-003", name: "Flow Cytometer", categoryId: bio.id, hourlyRateCents: 9500, location: "Lab 1.10", minTierLevel: 2, requiresCertification: true, bufferMinutes: 15 });
  const confocal = await eq({ assetTag: "IMG-001", name: "Confocal Microscope", categoryId: imaging.id, hourlyRateCents: 12000, location: "Imaging Suite A", minTierLevel: 2, requiresCertification: true, bookableFromHour: 7, bookableToHour: 22 });
  const sem = await eq({ assetTag: "IMG-002", name: "Scanning Electron Microscope", categoryId: imaging.id, hourlyRateCents: 25000, location: "Imaging Suite B", minTierLevel: 3, requiresCertification: true, requiresApproval: true, minBookingMinutes: 60, bufferMinutes: 30 });
  const lcms = await eq({ assetTag: "ANA-001", name: "LC-MS/MS", categoryId: analytical.id, hourlyRateCents: 18000, location: "Lab 2.01", restricted: true, requiresApproval: true, minBookingMinutes: 60, maxBookingMinutes: 720 });
  const nmr = await eq({ assetTag: "ANA-002", name: "NMR 600 MHz", categoryId: analytical.id, hourlyRateCents: 15000, location: "Lab 2.05", minTierLevel: 2, billingIncrementMinutes: 30 });

  await prisma.user.upsert({ where: { email: "admin@facility.test" }, update: {}, create: { email: "admin@facility.test", name: "Fiona Admin", role: "FACILITY_ADMIN", passwordHash: pw } });
  await prisma.user.upsert({ where: { email: "staff@facility.test" }, update: {}, create: { email: "staff@facility.test", name: "Sam Staff", role: "FACILITY_STAFF", passwordHash: pw } });

  const customer = async (name: string, tierId: string, extra: Partial<Parameters<typeof prisma.customer.create>[0]["data"]>, domain: string) => {
    const existing = await prisma.customer.findFirst({ where: { name } });
    const c = existing ?? (await prisma.customer.create({ data: { name, tierId, billingEmail: `ap@${domain}`, status: "ACTIVE", ...extra } as never }));
    const admin = await prisma.user.upsert({ where: { email: `lead@${domain}` }, update: {}, create: { email: `lead@${domain}`, name: `${name.split(" ")[0]} Lead`, role: "CUSTOMER_ADMIN", customerId: c.id, passwordHash: pw } });
    const member = await prisma.user.upsert({ where: { email: `scientist@${domain}` }, update: {}, create: { email: `scientist@${domain}`, name: `${name.split(" ")[0]} Scientist`, role: "CUSTOMER_MEMBER", customerId: c.id, passwordHash: pw } });
    return { c, admin, member };
  };

  const helix = await customer("Helix Bio Inc.", ent.id, { officeSuite: "Suite 3A", monthlyOfficeRentCents: 350000 }, "helixbio.test");
  const nova = await customer("Nova Therapeutics", pro.id, { officeSuite: "Suite 2C", monthlyOfficeRentCents: 180000, monthlyHourQuota: 120 }, "novatx.test");
  const pico = await customer("Pico Diagnostics", starter.id, {}, "picodx.test");

  await prisma.equipmentGrant.upsert({ where: { customerId_equipmentId: { customerId: helix.c.id, equipmentId: lcms.id } }, update: {}, create: { customerId: helix.c.id, equipmentId: lcms.id } });
  await prisma.customerEquipmentRate.upsert({ where: { customerId_equipmentId: { customerId: helix.c.id, equipmentId: confocal.id } }, update: {}, create: { customerId: helix.c.id, equipmentId: confocal.id, hourlyRateCents: 10000 } });
  for (const [u, e] of [[helix.member, confocal], [helix.member, sem], [helix.member, flow], [nova.member, flow], [nova.member, confocal]] as const)
    await prisma.userCertification.upsert({ where: { userId_equipmentId: { userId: u.id, equipmentId: e.id } }, update: {}, create: { userId: u.id, equipmentId: e.id } });

  // Usage history for last month so the usage review and invoicing screens have data.
  if ((await prisma.booking.count()) === 0) {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 3, 14));
    const mk = async (user: { id: string; customerId: string | null }, e: { id: string; hourlyRateCents: number }, dayOffset: number, hrs: number, status: string, overrunMin = 0) => {
      const startsAt = new Date(lastMonth.getTime() + dayOffset * 24 * HOUR);
      const endsAt = new Date(startsAt.getTime() + hrs * HOUR);
      await prisma.booking.create({
        data: {
          userId: user.id, customerId: user.customerId!, equipmentId: e.id, startsAt, endsAt, hourlyRateCents: e.hourlyRateCents, status: status as never,
          ...(status === "COMPLETED" ? { checkedInAt: startsAt, checkedOutAt: new Date(endsAt.getTime() + overrunMin * 60000) } : {}),
          ...(status === "CANCELLED" ? { cancelledAt: new Date(startsAt.getTime() - 5 * HOUR) } : {}),
        },
      });
    };
    await mk(helix.member, { ...confocal, hourlyRateCents: 10000 }, 0, 3, "COMPLETED");
    await mk(helix.member, sem, 2, 2, "COMPLETED", 20);
    await mk(helix.admin, lcms, 5, 6, "COMPLETED");
    await mk(helix.member, flow, 9, 2, "NO_SHOW");
    await mk(nova.member, flow, 1, 4, "COMPLETED");
    await mk(nova.member, confocal, 4, 2, "CANCELLED");
    await mk(nova.admin, nmr, 7, 3, "COMPLETED");
    await mk(pico.member, pcr, 3, 2, "COMPLETED");
    await mk(pico.admin, hood, 6, 4, "COMPLETED", 35);
  }
  console.log("Seeded. Log in with admin@facility.test / password123 or lead@helixbio.test / password123");
}

main().finally(() => prisma.$disconnect());
