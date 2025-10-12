import "dotenv/config";
import pkg from "@prisma/client";
import bcrypt from "bcryptjs";
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME || "admin";
  const name = process.env.ADMIN_NAME || "Administrator";
  const pass = process.env.ADMIN_PASSWORD || "Ani123--";
  const hash = await bcrypt.hash(pass, 10);

  await prisma.user.upsert({
    where: { username },
    update: { password: hash, role: "ADMIN", name },
    create: { username, name, password: hash, role: "ADMIN" },
  });
  console.log("Seed admin done:", username);
}

main().finally(() => prisma.$disconnect());
