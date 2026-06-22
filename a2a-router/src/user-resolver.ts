/**
 * Resolve a Gemini Enterprise end user from the Authorization header.
 *
 * GE attaches `Authorization: Bearer <ya29.access_token>` when the agent is
 * registered with an OAuth client. The token is opaque (Google's classic
 * access token format, not a JWT), so we exchange it at the userinfo
 * endpoint to get the actual user email / sub.
 *
 * Results are cached briefly so we don't hit userinfo on every turn of the
 * same conversation.
 */

import type { Request } from "express";

export interface ResolvedUser {
  /** Stable identifier we use for workstation naming (lower-case email). */
  id: string;
  /** Email address from userinfo (verified). */
  email: string;
  /** Google user id (sub). */
  sub: string;
}

const CACHE_TTL_MS = parseInt(
  process.env["A2A_USERINFO_CACHE_MS"] ?? "300000", // 5 min
  10,
);

const cache = new Map<string, { user: ResolvedUser; expiresAt: number }>();

function readBearer(req: Request): string | undefined {
  const v = req.headers["authorization"];
  const raw = Array.isArray(v) ? v[0] : v;
  if (!raw) return undefined;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : undefined;
}

interface UserInfoResponse {
  sub?: string;
  email?: string;
  email_verified?: boolean;
}

async function fetchUserInfo(token: string): Promise<UserInfoResponse> {
  const res = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    throw new Error(
      `userinfo failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  return (await res.json()) as UserInfoResponse;
}

/**
 * Resolve the GE end user from this request, or `null` if the request did
 * not include an end-user OAuth bearer (i.e. only the Discovery Engine SA
 * token was attached).
 */
export async function resolveUser(req: Request): Promise<ResolvedUser | null> {
  const token = readBearer(req);
  if (!token) return null;

  // Use the token itself as the cache key so revoked tokens stop working
  // when GE issues a fresh one.
  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  let info: UserInfoResponse;
  try {
    info = await fetchUserInfo(token);
  } catch (err) {
    console.warn(
      `userinfo lookup failed: ${(err as Error).message}; treating as anonymous`,
    );
    return null;
  }

  if (!info.email || !info.sub) {
    console.warn(`userinfo response missing email/sub: ${JSON.stringify(info)}`);
    return null;
  }

  const user: ResolvedUser = {
    id: info.email.toLowerCase(),
    email: info.email,
    sub: info.sub,
  };

  cache.set(token, { user, expiresAt: Date.now() + CACHE_TTL_MS });
  return user;
}

/**
 * Convert a user identifier into a Cloud Workstations workstation_id.
 * - Lower case
 * - Only [a-z0-9-]
 * - At most 50 chars (Workstations limit, leaving room for prefix)
 */
export function workstationIdForUser(userId: string): string {
  const slug = userId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `a2a-${slug}`;
}
