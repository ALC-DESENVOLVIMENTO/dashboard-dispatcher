import { randomBytes, scryptSync } from 'node:crypto';

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('Uso: npm run auth:hash -- "uma-senha-com-pelo-menos-12-caracteres"');
  process.exitCode = 1;
} else {
  const N = 16384;
  const r = 8;
  const p = 1;
  const salt = randomBytes(24).toString('hex');
  const digest = scryptSync(password, Buffer.from(salt, 'hex'), 64, {N, r, p, maxmem: 32 * 1024 * 1024});
  process.stdout.write(`scrypt$${N}$${r}$${p}$${salt}$${digest.toString('hex')}\n`);
}
