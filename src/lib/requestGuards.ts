function forbidden() {
  return new Response('Cross-origin form submissions are not allowed.', { status: 403 });
}

/**
 * Reject cross-origin POSTs (basic CSRF protection).
 *
 * Hardened to fail CLOSED: if neither an Origin nor a Referer header is present
 * we deny the request, instead of the previous behaviour which allowed it.
 * Browsers always send at least one of these on a same-site form submission,
 * so legitimate traffic is unaffected, while header-less scripted clients are blocked.
 */
export function requireSameOrigin(request: Request) {
  const requestOrigin = new URL(request.url).origin;

  const origin = request.headers.get('origin');
  if (origin) {
    return origin === requestOrigin ? null : forbidden();
  }

  // Fall back to the Referer header when Origin is absent.
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === requestOrigin ? null : forbidden();
    } catch {
      return forbidden();
    }
  }

  // No Origin and no Referer: deny.
  return forbidden();
}
