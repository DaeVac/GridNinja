import { Auth0Client } from "@auth0/nextjs-auth0/server";

const REQUIRED_AUTH0_ENV_VARS = [
  "AUTH0_SECRET",
  "AUTH0_BASE_URL",
  "AUTH0_ISSUER_BASE_URL",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
];

export const auth0Configured = REQUIRED_AUTH0_ENV_VARS.every(
  (key) => Boolean(process.env[key]),
);

export const auth0 = auth0Configured ? new Auth0Client() : null;

export async function getSessionSafe() {
  if (!auth0) {
    return null;
  }

  try {
    return await auth0.getSession();
  } catch {
    return null;
  }
}
