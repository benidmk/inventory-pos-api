// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import pkg from "@prisma/client";
import jwt from "jsonwebtoken";
import z from "zod";

const { PrismaClient } = pkg;
const prisma = new PrismaClient();
const app = express();

/**
 * CORS
 * Sementara izinkan semua origin agar frontend lokal & vercel mudah akses.
 * Kalau mau dibatasi: ganti ke baris di bawah (dan set env ALLOWED_ORIGIN).
 */
// app.use(cors({ origin: process.env.ALLOWED_ORIGIN?.split(',') ?? true, credentials: true }));
app.use(cors());
app.use(express.json());

/** Healthcheck */
app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));

/** ========== AUTH ========== */
/** Login sangat sederhana: cocok dengan ADMIN_PASSWORD lalu kirim JWT. */
app.post("/api/v1/auth/login", (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, {
    expiresIn: "12h",
  });
  res.json({ token });
});

/** Middleware JWT */
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  try {
    if (!token) throw new Error("no token");
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

/** ========== PRODUCTS ========== */
/** List (+search) */
app.get("/api/v1/products", auth, async (req, res) => {
  const q = (req.query.q || "").toString().toLowerCase();
  const list = await prisma.product.findMany({
    orderBy: { createdAt: "desc" },
  });
  const filtered = q
    ? list.filter((p) => p.name.toLowerCase().includes(q))
    : list;
  res.json(filtered);
});

/** Create */
app.post("/api/v1/products", auth, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    category: z.enum(["Pupuk", "Obat"]),
    unit: z.enum(["sak", "ml", "liter", "kg"]),
    costPrice: z.number().int().nonnegative(),
    sellPrice: z.number().int().nonnegative(),
    stockQty: z.number().int().nonnegative(),
    expiryDate: z.string().optional().nullable(),
    imageUrl: z.string().url().optional().nullable(),
    minStock: z.number().int().nonnegative().optional().default(5),
    isActive: z.boolean().optional().default(true),
  });
  try {
    const data = schema.parse(req.body);
    const created = await prisma.product.create({
      data: {
        ...data,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
      },
    });
    res.json(created);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Update */
app.put("/api/v1/products/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const payload = req.body || {};
    if (payload.expiryDate) payload.expiryDate = new Date(payload.expiryDate);
    const updated = await prisma.product.update({
      where: { id },
      data: payload,
    });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Delete */
app.delete("/api/v1/products/:id", auth, async (req, res) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** ========== CUSTOMERS ========== */
app.get("/api/v1/customers", auth, async (_req, res) => {
  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(customers);
});

app.post("/api/v1/customers", auth, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    phone: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  });
  try {
    const created = await prisma.customer.create({
      data: schema.parse(req.body),
    });
    res.json(created);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/v1/customers/:id", auth, async (req, res) => {
  try {
    const updated = await prisma.customer.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/v1/customers/:id", auth, async (req, res) => {
  try {
    await prisma.customer.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** ========== SALES / POS ========== */
app.post("/api/v1/sales", auth, async (req, res) => {
  const schema = z.object({
    customerId: z.string().optional().nullable(),
    note: z.string().optional().nullable(),
    items: z.array(
      z.object({ productId: z.string(), qty: z.number().int().positive() })
    ),
    amountPaid: z.number().int().nonnegative().default(0),
    method: z.enum(["Tunai", "Transfer", "QRIS"]).default("Tunai"),
  });

  try {
    const payload = schema.parse(req.body);

    // Ambil produk yang terlibat
    const ids = payload.items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: ids } },
    });
    if (products.length !== ids.length)
      throw new Error("Produk tidak ditemukan.");

    // Hitung total + validasi stok
    const calcItems = payload.items.map((i) => {
      const p = products.find((pp) => pp.id === i.productId);
      if (!p) throw new Error("Produk tidak ditemukan.");
      if (p.stockQty < i.qty) throw new Error(`Stok tidak cukup: ${p.name}`);
      const unitPrice = p.sellPrice;
      return { ...i, name: p.name, unitPrice, lineTotal: unitPrice * i.qty };
    });
    const grandTotal = calcItems.reduce((a, i) => a + i.lineTotal, 0);
    const status =
      payload.amountPaid >= grandTotal
        ? "Lunas"
        : payload.amountPaid > 0
        ? "Sebagian"
        : "Piutang";

    // Generate nomor invoice: INV-YYYYMM-####
    const now = new Date();
    const prefix = `INV-${now.getFullYear()}${String(
      now.getMonth() + 1
    ).padStart(2, "0")}-`;
    const count = await prisma.sale.count({
      where: { invoiceNo: { startsWith: prefix } },
    });
    const invoiceNo = `${prefix}${String(count + 1).padStart(4, "0")}`;

    const result = await prisma.$transaction(async (tx) => {
      const sale = await tx.sale.create({
        data: {
          invoiceNo,
          customerId: payload.customerId ?? null,
          note: payload.note ?? null,
          grandTotal,
          amountPaid: payload.amountPaid,
          paymentStatus: status,
          items: {
            create: calcItems.map((i) => ({
              productId: i.productId,
              qty: i.qty,
              unitPrice: i.unitPrice,
              lineTotal: i.lineTotal,
            })),
          },
        },
      });

      // Kurangi stok + catat movement
      for (const i of calcItems) {
        await tx.product.update({
          where: { id: i.productId },
          data: { stockQty: { decrement: i.qty } },
        });
        await tx.stockMovement.create({
          data: {
            productId: i.productId,
            type: "OUT",
            qty: i.qty,
            reason: "Sale",
            refId: sale.id,
            userId: "admin",
          },
        });
      }

      // Pembayaran awal, bila ada
      if (payload.amountPaid > 0) {
        await tx.payment.create({
          data: {
            saleId: sale.id,
            amount: payload.amountPaid,
            method: payload.method,
          },
        });
      }

      return sale;
    });

    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** List sales (filter status) – open = Piutang/Sebagian; else Lunas */
app.get("/api/v1/sales", auth, async (req, res) => {
  const status = req.query.status?.toString();
  const where = status
    ? status === "open"
      ? { paymentStatus: { in: ["Piutang", "Sebagian"] } }
      : { paymentStatus: "Lunas" }
    : {};
  const sales = await prisma.sale.findMany({
    where,
    orderBy: { date: "desc" },
  });
  res.json(sales);
});

/** ========== PAYMENTS ========== */
app.post("/api/v1/payments", auth, async (req, res) => {
  const schema = z.object({
    saleId: z.string(),
    amount: z.number().int().positive(),
    method: z.enum(["Tunai", "Transfer", "QRIS"]),
    refNo: z.string().optional().nullable(),
  });

  try {
    const payload = schema.parse(req.body);
    const sale = await prisma.sale.findUnique({
      where: { id: payload.saleId },
      include: { payments: true },
    });
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const paid = sale.payments.reduce((a, p) => a + p.amount, 0);
    const due = sale.grandTotal - paid;
    if (payload.amount > due)
      return res.status(400).json({ error: "Nominal melebihi sisa tagihan" });

    const saved = await prisma.$transaction(async (tx) => {
      const pay = await tx.payment.create({ data: { ...payload } });
      const newPaid = paid + payload.amount;
      const newStatus = newPaid >= sale.grandTotal ? "Lunas" : "Sebagian";
      await tx.sale.update({
        where: { id: sale.id },
        data: { amountPaid: newPaid, paymentStatus: newStatus },
      });
      return pay;
    });

    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** ========== REPORTS ========== */
/**
 * Perbaikan penting:
 * - Default: 30 hari terakhir
 * - "to" diset ke jam 23:59:59.999 agar transaksi di hari 'to' ikut terbaca.
 */
app.get("/api/v1/reports/sales", auth, async (req, res) => {
  try {
    const fromStr = (req.query.from || "").toString(); // 'YYYY-MM-DD'
    const toStr = (req.query.to || "").toString();

    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setDate(defaultFrom.getDate() - 30);
    defaultFrom.setHours(0, 0, 0, 0);

    const from = fromStr ? new Date(`${fromStr}T00:00:00.000Z`) : defaultFrom;

    const to = toStr
      ? new Date(`${toStr}T23:59:59.999Z`)
      : new Date(new Date().setHours(23, 59, 59, 999));

    const list = await prisma.sale.findMany({
      where: { date: { gte: from, lte: to } },
      orderBy: { date: "desc" },
    });
    const total = list.reduce((a, s) => a + s.grandTotal, 0);
    res.json({ total, list });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** ========== START SERVER ========== */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("API running on :" + port));
