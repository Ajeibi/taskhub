import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Passwords are hashed with scrypt from Node's standard library: memory-hard (resists GPU
// cracking), no native add-on to compile in the container, and no third-party dependency.
// The stored format is self-describing so parameters can be raised later without a migration:
//   scrypt$N$r$p$saltBase64$hashBase64
// Cost is fixed in production. Only the test runner lowers it (SCRYPT_N) so the suite is fast; a low value is
// refused outright when NODE_ENV=production so it can never be deployed by accident.
const N = Number(process.env.SCRYPT_N ?? 2 ** 15); // CPU/memory cost (~32 MiB per hash at the default)
if (process.env.NODE_ENV === 'production' && N < 2 ** 15) throw new Error('SCRYPT_N below 32768 is not allowed in production');
const R = 8;
const P = 1;
const KEY_LEN = 64;
const MAX_MEM = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  const options: ScryptOptions = { N: n, r, p, maxmem: MAX_MEM };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, len, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return timingSafeEqual(actual, expected); // constant-time comparison
}

// Verified when the email is unknown, so "no such user" and "wrong password" cost the same time
// and an attacker cannot enumerate accounts by measuring latency.
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('not-a-real-password');
  return dummy;
}
