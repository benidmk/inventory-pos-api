-- CreateTable
CREATE TABLE "public"."InvoiceCounter" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCounter_period_key" ON "public"."InvoiceCounter"("period");
