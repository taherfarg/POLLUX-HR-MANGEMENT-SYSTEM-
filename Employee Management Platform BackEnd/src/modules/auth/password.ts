import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

/**
 * bcryptjs rather than native bcrypt: it is pure JavaScript, so the project
 * installs and runs identically on Windows, macOS, Linux and in a container
 * with no build toolchain. Cost 12 is roughly 250ms on modern hardware - slow
 * enough to matter to an attacker, fast enough for an interactive login.
 */
const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Length is the dominant factor in password strength, so the floor is 10 rather
 * than the traditional 8, with a light character-mix requirement to rule out the
 * most obvious choices.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((value) => /[a-z]/.test(value), 'Password must contain a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Password must contain an uppercase letter')
  .refine((value) => /\d/.test(value), 'Password must contain a number');

/**
 * A one-time password for a new or reset account, from the operating system's
 * cryptographic random source. Always satisfies the password policy: at least
 * one uppercase letter, one lowercase letter and one digit. Look-alike
 * characters (0/O, 1/l/I) are left out so it can be read out over the phone.
 */
export function generateTemporaryPassword(length = 14): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const pick = (set: string): string => set.charAt(crypto.randomInt(set.length));

  const characters = [pick(upper), pick(lower), pick(digits)];
  while (characters.length < Math.max(length, 10)) characters.push(pick(all));
  // Fisher-Yates, so the guaranteed characters are not always first.
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    [characters[index], characters[swap]] = [characters[swap] as string, characters[index] as string];
  }
  return characters.join('');
}
