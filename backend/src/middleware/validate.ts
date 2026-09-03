import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";

/** Parses req.body against `schema`, replacing it with the parsed value on success. */
export function validate(schema: ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "validation_error",
        details: result.error.flatten(),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
