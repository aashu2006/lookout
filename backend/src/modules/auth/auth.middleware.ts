import type { Role } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config.js";
import { AppError } from "../../errors.js";
import { getUserById } from "./auth.service.js";

interface AccessTokenPayload {
  sub: string;
  role: Role;
}

function isAccessTokenPayload(payload: unknown): payload is AccessTokenPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).sub === "string"
  );
}

/** Verifies the bearer token and re-loads the user from the DB, so a deleted
 * user is rejected even when presenting an otherwise-valid token. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new AppError(401, "unauthorized", "Missing or invalid authorization header");
    }
    const token = header.slice("Bearer ".length).trim();

    let payload: unknown;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw new AppError(401, "unauthorized", "Invalid or expired token");
    }

    if (!isAccessTokenPayload(payload)) {
      throw new AppError(401, "unauthorized", "Invalid token payload");
    }

    const user = await getUserById(payload.sub);
    if (!user) {
      throw new AppError(401, "unauthorized", "User no longer exists");
    }

    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new AppError(403, "forbidden", "Insufficient permissions"));
      return;
    }
    next();
  };
}
