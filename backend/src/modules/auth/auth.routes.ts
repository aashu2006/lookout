import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth } from "./auth.middleware.js";
import { loginSchema, signupSchema, type LoginInput, type SignupInput } from "./auth.schemas.js";
import { getUserById, login, signup, toPublicUser } from "./auth.service.js";
import { AppError } from "../../errors.js";

export const authRouter = Router();

authRouter.post(
  "/signup",
  validate(signupSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as SignupInput;
    const result = await signup(email, password);
    res.status(201).json(result);
  }),
);

authRouter.post(
  "/login",
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as LoginInput;
    const result = await login(email, password);
    res.status(200).json(result);
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    // req.user is guaranteed by requireAuth; re-fetch for the full public shape (createdAt).
    const user = await getUserById(req.user!.id);
    if (!user) {
      throw new AppError(401, "unauthorized", "User no longer exists");
    }
    res.status(200).json({ user: toPublicUser(user) });
  }),
);
