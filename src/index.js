import "dotenv/config";
import express from "express";
import cors from "cors";
import pkg from "@prisma/client";
import jwt from "jsonwebtoken";
import z from "zod";

const { PrismaClient } = pkg;
const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));

// --- Auth sederhana: password tunggal, return JWT ---
app.post("/api/v1/auth/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: "Invalid password" });
  const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, {
    expiresIn: "12h",
  });
  res.json({ token });
});

// middleware auth
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

// ============== PRODUCTS ==============
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
  });
  const data = schema.parse(req.body);
  const created = await prisma.product.create({
    data: {
      ...data,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
    },
  });
  res.json(created);
});

app.put("/api/v1/products/:id", auth, async (req, res) => {
  const id = req.params.id;
  const data = req.body;
  const updated = await prisma.product.update({
    where: { id },
    data: {
      ...data,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
    },
  });
  res.json(updated);
});

app.delete("/api/v1/products/:id", auth, async (req, res) => {
  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ============== CUSTOMERS ==============
app.get("/api/v1/customers", auth, async (_req, res) => {
  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(customers);
});

app.post("/api/v1/customers", auth, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
  });
  const created = await prisma.customer.create({
    data: schema.parse(req.body),
  });
  res.json(created);
});

app.put("/api/v1/customers/:id", auth, async (req, res) => {
  const updated = await prisma.customer.update({
    where: { id: req.params.id },
    data: req.body,
  });
  res.json(updated);
});

app.delete("/api/v1/customers/:id", auth, async (req, res) => {
  await prisma.customer.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ============== SALES ==============
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
  const payload = schema.parse(req.body);

  // ambil produk
  const ids = payload.items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
  });

  // hitung & validasi stok
  const calcItems = payload.items.map((i) => {
    const p = products.find((pp) => pp.id === i.productId);
    if (!p) throw new Error("Produk tidak ditemukan.");
    if (p.stockQty < i.qty) throw new Error(`Stok tidak cukup: ${p.name}`);
    const unitPrice = p.sellPrice;
    return { ...i, unitPrice, lineTotal: unitPrice * i.qty };
  });
  const grandTotal = calcItems.reduce((a, i) => a + i.lineTotal, 0);
  const status =
    payload.amountPaid >= grandTotal
      ? "Lunas"
      : payload.amountPaid > 0
      ? "Sebagian"
      : "Piutang";

  // nomor invoice
  const now = new Date();
  const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}-`;
  const count = await prisma.sale.count({
    where: { invoiceNo: { startsWith: prefix } },
  });
  const invoiceNo = `${prefix}${String(count + 1).padStart(4, "0")}`;

  try {
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

      // kurangi stok + movement
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

      // catat payment awal jika ada
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

// daftar invoice terbuka
app.get("/api/v1/sales", auth, async (req, res) => {
  const status = req.query.status?.toString();
  const where = status
    ? {
        paymentStatus:
          status === "open" ? { in: ["Piutang", "Sebagian"] } : "Lunas",
      }
    : {};
  const sales = await prisma.sale.findMany({
    where,
    orderBy: { date: "desc" },
  });
  res.json(sales);
});

// ============== PAYMENTS ==============
app.post("/api/v1/payments", auth, async (req, res) => {
  const schema = z.object({
    saleId: z.string(),
    amount: z.number().int().positive(),
    method: z.enum(["Tunai", "Transfer", "QRIS"]),
    refNo: z.string().optional(),
  });
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
});

// ============== REPORTS (ringkas) ==============
app.get("/api/v1/reports/sales", auth, async (req, res) => {
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date("1970-01-01");
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const list = await prisma.sale.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: { date: "desc" },
  });
  const total = list.reduce((a, s) => a + s.grandTotal, 0);
  res.json({ total, list });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("API running on :" + port));
