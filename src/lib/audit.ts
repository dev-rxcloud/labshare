import { Prisma } from "@prisma/client";
import { prisma } from "./db";

export async function audit(actorId: string | null, action: string, entity: string, entityId?: string, data?: unknown) {
  await prisma.auditLog.create({
    data: { actorId, action, entity, entityId, data: data === undefined ? undefined : (data as Prisma.InputJsonValue) },
  });
}
