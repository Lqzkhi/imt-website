import { defineMiddleware } from 'astro:middleware';

const productionDirectives = import.meta.env.PROD ? ['upgrade-insecure-requests'] : [];
function contentSecurityPolicy(pathname: string) {
  // The legacy competition map loads a small inline ES module from jsDelivr.
  // Keep that exception scoped to its page; the Test Portal never permits inline scripts.
  const scripts = pathname === '/competitions/spring-2026'
    ? "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://va.vercel-scripts.com"
    : "script-src 'self' https://va.vercel-scripts.com";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://formspree.io",
    scripts,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://cdn.jsdelivr.net https://formspree.io https://*.supabase.co wss://*.supabase.co https://vitals.vercel-insights.com https://*.vercel-insights.com ws://localhost:* ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...productionDirectives,
  ].join('; ');
}

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', contentSecurityPolicy(context.url.pathname));
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-site');
  if (context.url.protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
