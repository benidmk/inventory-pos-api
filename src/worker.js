// src/worker.js
import { Hono } from "hono";
import { cors } from "hono/cors";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";

const app = new Hono();

// CORS — kalau mau ketat, ubah CORS_ORIGIN di wrangler.toml
app.use(
  "/api/*",
  cors({
    // signature: (origin, c) => ...
    origin: (origin, c) => c?.env?.CORS_ORIGIN ?? "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    maxAge: 86400,
    credentials: false,
  })
);

// helper koneksi SQL
const sql = (env) => neon(env.DATABASE_URL);

// helper jwt
const sign = async (payload, secret, exp = "12h") =>
  await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));

const verify = async (token, secret) =>
  await jwtVerify(token, new TextEncoder().encode(secret));

// middleware auth
const auth = async (c, next) => {
  const h = c.req.header("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  try {
    const { payload } = await verify(token, c.env.JWT_SECRET);
    c.set("user", payload); // { sub, role, name, username }
    await next();
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
};

// role guard
const allow =
  (...roles) =>
  async (c, next) => {
    const u = c.get("user");
    if (!u || !roles.includes(u.role))
      return c.json({ error: "Forbidden" }, 403);
    await next();
  };

// healthcheck
app.get("/api/v1/health", (c) => c.json({ ok: true }));

// ===== AUTH: username + password =====
app.post("/api/v1/auth/login", async (c) => {
  try {
    const { username = "", password = "" } = await c.req.json();
    const rows = await sql(c.env)`
      SELECT id, username, name, password, role, "createdAt"
      FROM "User"
      WHERE username = ${username}
      LIMIT 1
    `;
    if (!rows.length) return c.json({ error: "Invalid credentials" }, 401);

    const user = rows[0];
    const ok = await bcrypt.compare(String(password), user.password);

    // Login audit (best effort; jangan blokir walau error)
    try {
      const ip =
        c.req.header("CF-Connecting-IP") ||
        c.req.header("x-forwarded-for") ||
        null;
      const ua = c.req.header("user-agent") || null;
      await sql(c.env)`
        INSERT INTO "LoginAudit" ("userId", username, role, ip, "userAgent")
        VALUES (${user.id}, ${user.username}, ${user.role}, ${ip}, ${ua})
      `;
    } catch (_) {}

    if (!ok) return c.json({ error: "Invalid credentials" }, 401);

    const token = await sign(
      {
        sub: user.id,
        role: user.role,
        name: user.name,
        username: user.username,
      },
      c.env.JWT_SECRET,
      "12h"
    );

    return c.json({
      token,
      role: user.role,
      name: user.name,
      username: user.username,
    });
  } catch (e) {
    return c.json({ error: e.message || "Bad Request" }, 400);
  }
});

// ===== PRODUCTS: GET list (ADMIN & VIEWER)
app.get("/api/v1/products", auth, async (c) => {
  const q = (c.req.query("q") || "").toLowerCase();
  const rows = await sql(c.env)`
    SELECT id, name, category, unit, "costPrice", "sellPrice", "stockQty",
           "expiryDate", "imageUrl", "minStock", "isActive", "createdAt"
    FROM "Product"
    WHERE "isActive" = true
    ORDER BY "createdAt" DESC
  `;
  const list = q
    ? rows.filter((p) => (p.name || "").toLowerCase().includes(q))
    : rows;
  return c.json(list);
});

// ===== USERS: contoh admin-only (opsional)
app.get("/api/v1/users", auth, allow("ADMIN"), async (c) => {
  const rows = await sql(c.env)`
    SELECT id, username, name, role, "createdAt" FROM "User" ORDER BY "createdAt" DESC
  `;
  return c.json(rows);
});

app.post("/api/v1/users", auth, allow("ADMIN"), async (c) => {
  try {
    const { username, name, password, role = "VIEWER" } = await c.req.json();
    if (!username || !password || !name)
      return c.json({ error: "Incomplete data" }, 400);
    const hash = await bcrypt.hash(String(password), 10);
    const rows = await sql(c.env)`
      INSERT INTO "User" (username, name, password, role)
      VALUES (${username}, ${name}, ${hash}, ${role})
      RETURNING id, username, name, role, "createdAt"
    `;
    return c.json(rows[0]);
  } catch (e) {
    if (String(e.message || "").includes("duplicate")) {
      return c.json({ error: "Username already exists" }, 409);
    }
    return c.json({ error: e.message || "Bad Request" }, 400);
  }
});

// ===== AUDIT: admin-only (opsional)
app.get("/api/v1/audits/login", auth, allow("ADMIN"), async (c) => {
  const rows = await sql(c.env)`
    SELECT id, "userId", username, role, ip, "userAgent", at
    FROM "LoginAudit"
    ORDER BY at DESC
    LIMIT 200
  `;
  return c.json(rows);
});

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
};
