import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { localRequestAllowed } from './lib/local-security.mjs';

export function proxy(request: NextRequest) {
  if (!localRequestAllowed(request)) return new Response('仅支持本机同源访问。', {status: 403, headers: {'Cache-Control': 'no-store'}});
  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Content-Security-Policy', "frame-ancestors 'none'; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'");
  return response;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.svg).*)'] };
