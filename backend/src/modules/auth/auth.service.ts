import type { User } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { AppError } from "../../errors.js";

const BCRYPT_COST = 12;

// Precomputed at startup so a login against a non-existent email still pays the
// same bcrypt cost as a real comparison, keeping response timing constant.
const DUMMY_HASH = bcrypt.hashSync("timing-safety-dummy-password", BCRYPT_COST);

export type PublicUser = Pick<User, "id" | "email" | "role" | "createdAt">;

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function signToken(user: Pick<User, "id" | "role">): string {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions);
}

export async function signup(
  email: string,
  password: string,
): Promise<{ user: PublicUser; token: string }> {
  const normalizedEmail = normalizeEmail(email);

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    throw new AppError(409, "email_taken", "An account with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const role = config.adminEmails.has(normalizedEmail) ? "ADMIN" : "USER";

  const user = await prisma.user.create({
    data: { email: normalizedEmail, passwordHash, role },
  });

  return { user: toPublicUser(user), token: signToken(user) };
}

export async function login(
  email: string,
  password: string,
): Promise<{ user: PublicUser; token: string }> {
  const normalizedEmail = normalizeEmail(email);

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  const isValid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !isValid) {
    throw new AppError(401, "invalid_credentials", "Invalid email or password");
  }

  return { user: toPublicUser(user), token: signToken(user) };
}

export async function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}
