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

/* ============== CORS: allow-all sementara ============== */
app.use(
  cors({
    origin: true, // echo origin -> Access-Control-Allow-Origin
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

/* ============== Healthcheck ============== */
app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));

/* ============== AUTH ============== */
app.post("/api/v1/auth/login", (req, res) => {
  const raw = req.body?.password ?? "";
  const input = String(raw).trim(); // buang spasi/enter tak terlihat
  const ADMIN = String(process.env.ADMIN_PASSWORD ?? "").trim();

  // Log diagnostik aman
  const toCodes = (s) =>
    s
      .split("")
      .slice(0, 3)
      .map((c) => c.charCodeAt(0));
  console.log("[LOGIN]", {
    inputLen: input.length,
    adminLen: ADMIN.length,
    inputFirstCodes: toCodes(input),
    adminFirstCodes: toCodes(ADMIN),
  });

  if (!process.env.JWT_SECRET) {
    return res
      .status(500)
      .json({ error: "Server misconfigured: JWT_SECRET missing" });
  }
  if (!input || input !== ADMIN) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, {
    expiresIn: "12h",
  });
  res.json({ token });
});

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

/* ================= PRODUCTS ================= */
app.get("/api/v1/products", auth, async (req, res) => {
  const q = (req.query.q || "").toString().toLowerCase();
  const list = await prisma.product.findMany({
    where: { isActive: true }, // <— tampilkan hanya produk aktif
    orderBy: { createdAt: "desc" },
  });
  res.json(q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list);
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
    isActive: z.boolean().optional().default(true),
  });
  try {
    const data = schema.parse(req.body);
    const created = await prisma.product.create({
      data: {
        ...data,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
        isActive: true, // default aktif
      },
    });
    res.json(created);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/v1/products/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const payload = { ...req.body };
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

app.delete("/api/v1/products/:id", auth, async (req, res) => {
  try {
    await prisma.product.update({
      where: { id: req.params.id },
      data: { isActive: false }, // <— tandai non-aktif, bukan hard delete
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Tambah stok (barang masuk) — hanya tambah qty, simpan riwayat */
app.post("/api/v1/products/:id/add-stock", auth, async (req, res) => {
  const schema = z.object({
    qty: z.number().int().positive(),
    unitCost: z.number().int().nonnegative().optional(),
    note: z.string().optional().nullable(),
  });
  try {
    const { qty, unitCost, note } = schema.parse(req.body);
    const productId = req.params.id;

    const prod = await prisma.product.findUnique({ where: { id: productId } });
    if (!prod) return res.status(404).json({ error: "Produk tidak ditemukan" });

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.product.update({
        where: { id: productId },
        data: { stockQty: { increment: qty } },
      });
      await tx.stockMovement.create({
        data: {
          productId,
          type: "IN",
          qty,
          reason: "StockIn",
          userId: "admin",
          unitCost: typeof unitCost === "number" ? unitCost : null,
          note: note ?? null,
        },
      });
      return p;
    });

    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ================= CUSTOMERS ================= */
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

/* ================= SALES / POS ================= */
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

  const calcStatus = (paid, total) =>
    paid >= total ? "Lunas" : paid > 0 ? "Sebagian" : "Piutang";

  // Helper: ambil nomor invoice dari PostgreSQL sequence (anti-duplicate)
  async function nextInvoiceNoSeq(tx) {
    const now = new Date();
    const period = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(
      2,
      "0"
    )}`; // YYYYMM
    const prefix = `INV-${period}-`;

    // 1) Pastikan sequence ada (idempotent)
    await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS inv_global_seq`);

    // 2) Ambil nomor baru (non-transactional, tidak rollback)
    const rows = await tx.$queryRawUnsafe(
      `SELECT nextval('inv_global_seq') AS seq`
    );
    const seq = Array.isArray(rows) ? rows[0].seq : rows.seq;

    // 3) Format jadi INV-YYYYMM-000123
    const invoiceNo = `${prefix}${String(seq).padStart(6, "0")}`;
    return { invoiceNo };
  }

  try {
    const payload = schema.parse(req.body);

    // Validasi produk & stok
    const ids = payload.items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: ids } },
    });
    if (products.length !== ids.length)
      throw new Error("Produk tidak ditemukan.");

    const calcItems = payload.items.map((i) => {
      const p = products.find((pp) => pp.id === i.productId);
      if (!p) throw new Error("Produk tidak ditemukan.");
      if (p.stockQty < i.qty) throw new Error(`Stok tidak cukup: ${p.name}`);
      const unitPrice = p.sellPrice;
      return { ...i, unitPrice, lineTotal: unitPrice * i.qty };
    });

    const grandTotal = calcItems.reduce((a, i) => a + i.lineTotal, 0);
    const status = calcStatus(payload.amountPaid, grandTotal);

    // Transaksi utama
    const sale = await prisma.$transaction(async (tx) => {
      const { invoiceNo } = await nextInvoiceNoSeq(tx);

      const s = await tx.sale.create({
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

      // Stok & movement
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
            refId: s.id,
            userId: "admin",
          },
        });
      }

      // Pembayaran awal
      if (payload.amountPaid > 0) {
        await tx.payment.create({
          data: {
            saleId: s.id,
            amount: payload.amountPaid,
            method: payload.method,
          },
        });
      }

      return s;
    });

    res.json(sale);
  } catch (e) {
    if (e?.code === "P2002" && e?.meta?.target?.includes("invoiceNo")) {
      // Dengan sequence, ini mestinya tidak terjadi; fallback pesan ramah
      return res
        .status(409)
        .json({ error: "Nomor invoice bentrok, silakan coba lagi." });
    }
    res.status(400).json({ error: e.message });
  }
});

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

/* ================= PAYMENTS ================= */
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

/* ================= REPORTS ================= */
// Penjualan
app.get("/api/v1/reports/sales", auth, async (req, res) => {
  try {
    const fromStr = (req.query.from || "").toString();
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

// Barang Masuk
app.get("/api/v1/reports/stock-in", auth, async (req, res) => {
  try {
    const fromStr = (req.query.from || "").toString();
    const toStr = (req.query.to || "").toString();

    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setDate(defaultFrom.getDate() - 30);
    defaultFrom.setHours(0, 0, 0, 0);

    const from = fromStr ? new Date(`${fromStr}T00:00:00.000Z`) : defaultFrom;
    const to = toStr
      ? new Date(`${toStr}T23:59:59.999Z`)
      : new Date(new Date().setHours(23, 59, 59, 999));

    const list = await prisma.stockMovement.findMany({
      where: { type: "IN", date: { gte: from, lte: to } },
      include: { product: true },
      orderBy: { date: "desc" },
    });

    const totalQty = list.reduce((a, m) => a + m.qty, 0);
    const totalValue = list.reduce((a, m) => a + (m.unitCost ?? 0) * m.qty, 0);

    const data = list.map((m) => ({
      id: m.id,
      date: m.date,
      productId: m.productId,
      productName: m.product.name,
      qty: m.qty,
      unitCost: m.unitCost ?? 0,
      value: (m.unitCost ?? 0) * m.qty,
      note: m.note || "",
    }));

    res.json({ totalQty, totalValue, list: data });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DETAIL 1 INVOICE
app.get("/api/v1/sales/:id/detail", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const sale = await prisma.sale.findUnique({
      where: { id }, // id = String (cuid) sesuai schema kamu
      include: {
        customer: {
          select: { id: true, name: true, phone: true, address: true },
        },
        items: {
          include: {
            product: {
              select: { id: true, name: true, unit: true, expiryDate: true },
            },
          },
        },
        payments: {
          select: {
            id: true,
            date: true,
            amount: true,
            method: true,
            refNo: true,
          },
        },
      },
    });
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const items = sale.items.map((it) => ({
      productId: it.productId,
      productName: it.product?.name ?? "-",
      unit: it.product?.unit ?? "-",
      qty: it.qty,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal,
      expiryDate: it.product?.expiryDate ?? null,
    }));
    const paid = sale.payments.reduce((a, p) => a + p.amount, 0);

    return res.json({
      id: sale.id,
      invoiceNo: sale.invoiceNo,
      date: sale.date,
      customer: sale.customer
        ? {
            id: sale.customer.id,
            name: sale.customer.name,
            phone: sale.customer.phone ?? null,
            address: sale.customer.address ?? null,
          }
        : null,
      note: sale.note ?? null,
      grandTotal: sale.grandTotal,
      amountPaid: paid,
      paymentStatus: sale.paymentStatus,
      items,
      payments: sale.payments,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ====== PROFIT (pendapatan - HPP) ======
app.get("/api/v1/reports/profit", auth, async (req, res) => {
  try {
    const fromStr = (req.query.from || "").toString().trim();
    const toStr = (req.query.to || "").toString().trim();

    // Jika from/to kosong => mode all-time
    const useRange = !!(fromStr && toStr);

    let whereSaleItem = {};
    if (useRange) {
      const from = new Date(`${fromStr}T00:00:00.000Z`);
      const to = new Date(`${toStr}T23:59:59.999Z`);
      whereSaleItem = { sale: { date: { gte: from, lte: to } } };
    }

    // Ambil item penjualan sesuai filter (atau semua jika all-time)
    const items = await prisma.saleItem.findMany({
      where: whereSaleItem,
      select: { qty: true, lineTotal: true, productId: true },
    });

    // Revenue = sum(lineTotal)
    const revenue = items.reduce((a, it) => a + (it.lineTotal || 0), 0);

    // Ambil costPrice per produk yang muncul di items
    const pids = Array.from(new Set(items.map((i) => i.productId)));
    const products = pids.length
      ? await prisma.product.findMany({
          where: { id: { in: pids } },
          select: { id: true, costPrice: true },
        })
      : [];
    const costMap = new Map(products.map((p) => [p.id, p.costPrice || 0]));

    // COGS = sum(qty * costPrice sekarang) -> aproksimasi
    const cogs = items.reduce((a, it) => {
      const cp = costMap.get(it.productId) || 0;
      return a + cp * it.qty;
    }, 0);

    const profit = revenue - cogs;

    // Info periode (untuk label)
    const agg = await prisma.sale.aggregate({
      _min: { date: true },
      _max: { date: true },
    });

    res.json({
      mode: useRange ? "range" : "all-time",
      range: useRange ? { from: fromStr, to: toStr } : null,
      dataset: {
        firstSaleAt: agg._min.date || null,
        lastSaleAt: agg._max.date || null,
        saleItems: items.length,
        productsInvolved: pids.length,
      },
      revenue, // total penjualan (gross)
      cogs, // HPP aproksimasi dari Product.costPrice
      profit, // keuntungan kotor keseluruhan / periode
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// ====== TOTAL PENJUALAN (all-time / range) ======
app.get("/api/v1/reports/total-sales", auth, async (req, res) => {
  try {
    const fromStr = (req.query.from || "").toString().trim();
    const toStr = (req.query.to || "").toString().trim();
    const useRange = !!(fromStr && toStr);

    let where = {};
    if (useRange) {
      const from = new Date(`${fromStr}T00:00:00.000Z`);
      const to = new Date(`${toStr}T23:59:59.999Z`);
      where = { date: { gte: from, lte: to } };
    }

    const agg = await prisma.sale.aggregate({
      where,
      _sum: { grandTotal: true },
      _min: { date: true },
      _max: { date: true },
    });

    res.json({
      mode: useRange ? "range" : "all-time",
      range: useRange ? { from: fromStr, to: toStr } : null,
      total: agg._sum.grandTotal || 0,
      firstSaleAt: agg._min.date || null,
      lastSaleAt: agg._max.date || null,
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

/* ============== START SERVER ============== */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("API running on :" + port));
