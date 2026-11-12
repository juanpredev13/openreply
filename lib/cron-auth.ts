import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Cron routes run jobs across every workspace, so they must fail closed: with
 * no secret configured nothing is authorized (never compare against the
 * string "Bearer undefined"), and the comparison is constant time.
 */
export function isAuthorizedCron(authorization: string | null): boolean {
  const secret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret || !authorization) return false;
  const presented = createHash("sha256").update(authorization).digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(presented, expected);
}
