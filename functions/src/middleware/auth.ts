import { Request, Response, NextFunction } from "express";
import { getAuth } from "firebase-admin/auth";

/**
 * Augment the Express Request type globally so all route handlers
 * can access `req.uid` and `req.email` after the auth middleware runs.
 */
declare global {
  namespace Express {
    interface Request {
      uid?: string;
      email?: string;
    }
  }
}

/**
 * Express middleware that verifies the Firebase ID token from the
 * Authorization header. Sets `req.uid` and `req.email` on success.
 *
 * Expected header: `Authorization: Bearer <idToken>`
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    req.email = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
