-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[];
