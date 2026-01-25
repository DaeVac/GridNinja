import { Auth0Client } from '@auth0/nextjs-auth0/server';
import { NextResponse, type NextRequest } from "next/server";

const appBaseUrl =
  process.env.APP_BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3000";

const issuerBaseUrl = process.env.AUTH0_ISSUER_BASE_URL;
const domain =
  process.env.AUTH0_DOMAIN ||
  (issuerBaseUrl
    ? issuerBaseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : undefined);

const isAuth0Configured =
  !!domain &&
  !!process.env.AUTH0_CLIENT_ID &&
  !!process.env.AUTH0_SECRET &&
  (!!process.env.AUTH0_CLIENT_SECRET ||
    !!process.env.AUTH0_CLIENT_ASSERTION_SIGNING_KEY);

type Auth0Adapter = {
  middleware: (request: NextRequest) => ReturnType<typeof NextResponse.next>;
  getSession: (
    request?: Request | NextRequest
  ) => Promise<{ user?: { name?: string; email?: string; picture?: string } } | null>;
};

const devFallbackAuth0: Auth0Adapter = {
  middleware: (request: NextRequest) => {
    const { pathname, searchParams } = request.nextUrl;

    if (pathname === "/auth/login") {
      const returnTo = searchParams.get("returnTo") ?? "/";
      return NextResponse.redirect(new URL(returnTo, request.url));
    }

    if (pathname === "/auth/logout" || pathname === "/auth/callback") {
      return NextResponse.redirect(new URL("/", request.url));
    }

    return NextResponse.next();
  },
  getSession: async () => null,
};

if (!isAuth0Configured && process.env.NODE_ENV === "production") {
  throw new Error(
    "Missing Auth0 configuration. Set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_SECRET, and AUTH0_CLIENT_SECRET."
  );
}

if (!isAuth0Configured && process.env.NODE_ENV !== "production") {
  console.warn(
    "Auth0 configuration missing. Using dev fallback session for local development."
  );
}

export const hasAuth0Config = isAuth0Configured;

export const auth0: Auth0Adapter | Auth0Client = isAuth0Configured
  ? new Auth0Client({ appBaseUrl, domain: domain as string })
  : devFallbackAuth0;
