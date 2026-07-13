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

/**
 * Limiter for the email-push confirmation send. Each request mails a real
 * message to the user's address, so this is an email-bomb vector if left on the
 * generous shared writeLimiter. Keyed by user id (the route is behind
 * requireAuth) so the cap is per-recipient, not per-IP — users behind a shared
 * NAT don't throttle each other.
 */
export const emailConfirmLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5, // 5 confirmation emails per hour per user
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? req.ip),
  message: { error: 'Too many confirmation emails requested. Try again later.' },
});

/**
 * Limiter for the "forgot password" request. The endpoint is unauthenticated
 * and mails a link to a user-supplied address, so it's both an email-bomb and
 * an enumeration-probe vector. Keyed by IP and capped tightly. (The route also
 * returns the same response whether or not the email exists, so the cap is the
 * main brake on abuse.)
 */
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5, // 5 reset emails per hour per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many password-reset requests. Try again later.' },
});

/**
 * Limiter for submitting a new password via a reset token. Caps brute-forcing
 * of the token space from a single IP; tokens are 256-bit random so this is
 * defense-in-depth, not the primary guard.
 */
export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

/**
 * Limiter for the AI scope-suggestion endpoint. Each request makes a paid,
 * slow call to the OpenAI-compatible endpoint, so it's a cost vector if left on
 * the generous shared writeLimiter. Keyed by user id (the route is behind
 * requireAuth) so the cap is per-user, not per-IP.
 */
export const aiSuggestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // 20 suggestions per window per user
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? req.ip),
  message: { error: 'Too many suggestion requests. Try again shortly.' },
});

/**
 * Limiter for triggering an on-demand report. Each request can fan out to many
 * paced arXiv fetches plus paid OpenAI calls, so it's a cost + external-load
 * vector if left on the generous shared writeLimiter. Keyed by user id (the
 * route is behind requireAuth) so the cap is per-user. A per-user active-job
 * guard in the route also blocks concurrent runs; this bounds the total rate.
 */
export const reportGenerateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 20, // 20 report triggers per hour per user
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? req.ip),
  message: { error: 'Too many report requests. Try again later.' },
});
