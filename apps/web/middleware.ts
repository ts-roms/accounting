import { NextResponse, type NextRequest } from 'next/server';
import { COOKIES } from '@accounting/config';

const PUBLIC_PATHS = ['/login'];

/**
 * Edge gate: users without a session cookie are sent to /login before any page
 * renders. This is a UX shortcut only - every API call is authorised server-side.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(COOKIES.REFRESH_TOKEN)?.value);
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  if (hasSession && isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*[.](?:svg|png|jpg|ico)).*)'],
};
