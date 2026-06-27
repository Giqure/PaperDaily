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

/**
 * Limiter for the email-existence probe used by the login page to decide
 * whether to show the signup form. This endpoint reveals whether an email is
 * registered, so throttle it to make bulk enumeration impractical.
 */
export const checkEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // 20 probes per window per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

/**
 * Limiter for authenticated write operations (managing subscriptions and paper
 * state). Generous enough for normal interactive use, but caps runaway clients
 * or scripted abuse. Keyed by IP.
 */
export const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 200, // 200 writes per window per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
});
