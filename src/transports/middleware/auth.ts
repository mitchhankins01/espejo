import type { Request, Response } from "express";

/**
 * Check bearer token auth. Returns true if authorized, false if unauthorized
 * (and sends 401 response). When no secret is configured, always allows.
 */
export function requireBearerAuth(
  req: Request,
  res: Response,
  secret: string
): boolean {
  if (!secret) return true;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  /* v8 ignore next */
  return true;
}
