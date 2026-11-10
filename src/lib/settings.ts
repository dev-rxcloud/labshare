import { prisma } from "./db";

export type Settings = Awaited<ReturnType<typeof getSettings>>;

/** Facility settings with Decimal fields converted to numbers. */
export async function getSettings() {
  const s = await prisma.facilitySettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  return { ...s, taxRatePercent: Number(s.taxRatePercent), lateFeePercent: Number(s.lateFeePercent) };
}
