// Creates (or resets the password of) an operator admin — the first account, since the admin UI
// needs a login. Usage: npm run create-admin -- you@suzaliconseil.com "Your Name"
// Prints a generated password once; change it from the admin UI afterwards.

import "dotenv/config";
import { prisma } from "../lib/db";
import { generatePassword, hashPassword } from "../lib/auth/password";

async function main() {
  const [emailRaw, name] = process.argv.slice(2);
  if (!emailRaw) {
    console.error('Usage: npm run create-admin -- <email> "<name>"');
    process.exitCode = 1;
    return;
  }
  const email = emailRaw.trim().toLowerCase();
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  await prisma.user.upsert({
    where: { email },
    create: { email, name: name || email, passwordHash, role: "ADMIN" },
    update: { passwordHash, role: "ADMIN", clientId: null, isActive: true, failedLogins: 0, lockedUntil: null },
  });
  console.log(`\nAdmin ${email} ready. Password (shown once):\n\n${password}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
