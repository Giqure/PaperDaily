/**
 * CSRF defense via Origin/Referer checking for state-changing requests.
 *
 * This complements the cookie's `sameSite: 'lax'` setting (the primary
 * defense) and the JSON-only body parser. For unsafe methods (POST/PUT/
 * PATCH/DELETE) we require that, when an Origin (or Referer) header is
 * present, it matches an allowed origin. Browsers always attach Origin on
 * cross-origin and same-origin unsafe requests, so a forged cross-site POST
 * is rejected here even in edge cases `sameSite=lax` doesn't cover.
 *
 * Requests with no Origin/Referer at all (e.g. server-to-server or curl) are
 * allowed through — they aren't browser CSRF vectors, and the session cookie
 * still gates anything sensitive.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfOriginCheck(allowedOrigins) {
  const allowed = new Set(allowedOrigins);

  return function (req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get('origin');
    const referer = req.get('referer');

    // Derive the origin from Referer when Origin is absent.
    let candidate = origin;
    if (!candidate && referer) {
      try {
        candidate = new URL(referer).origin;
      } catch {
        candidate = referer; // unparseable — will fail the allowlist below
      }
    }

    // No browser-supplied origin info: not a CSRF vector. Allow.
    if (!candidate) return next();

    if (allowed.has(candidate)) return next();

    return res.status(403).json({ error: 'Cross-origin request blocked.' });
  };
}
