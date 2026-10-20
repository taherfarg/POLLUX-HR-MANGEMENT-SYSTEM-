import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { verifyAccessToken } from '../modules/auth/token.service';

function limitReached(message: string) {
  return {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message,
    },
  };
}

/**
 * Tight limit on the credential endpoints, keyed by IP, to make online password
 * guessing impractical. This works alongside the per-account lockout in the auth
 * service, which defends an individual account against a distributed attempt.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.RATE_LIMIT_AUTH_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  message: limitReached('Too many authentication attempts. Try again in 15 minutes.'),
});

/**
 * Signed-in calls are counted per account, everything else per IP. Everyone in
 * the office shares one public address, and chat polls in the background - an
 * IP-wide ceiling would let a busy office lock itself out. A token that does
 * not verify falls back to the IP, so a forged one buys nothing.
 */
export function apiRateLimitKey(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      return `user:${verifyAccessToken(header.slice('Bearer '.length).trim()).sub}`;
    } catch {
      // Expired or invalid: counted against the address like any anonymous call.
    }
  }
  return `ip:${req.ip ?? 'unknown'}`;
}

/** Broad ceiling for the rest of the API - protects against runaway clients. */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.RATE_LIMIT_API_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: apiRateLimitKey,
  skip: () => env.isTest,
  message: limitReached('Request limit exceeded. Please slow down.'),
});
