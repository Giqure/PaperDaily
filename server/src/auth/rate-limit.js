import { rateLimit } from 'express-rate-limit';

/**
 * Limiter for login attempts. Keyed by client IP. Counts only failed attempts
 * (skipSuccessfulRequests) so a legitimate user who logs in cleanly isn't
 * penalized, while brute-force guessing is throttled hard.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // 10 failed attempts per window per IP
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

/**
 * Limiter for signups. Caps how many accounts a single IP can create, to blunt
 * automated signup spam. Counts all attempts.
 */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5, // 5 signups per hour per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this address. Try again later.' },
});
