import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";

/** Validates the body or query with `schema`. The parsed body replaces
 * req.body; the parsed query goes on res.locals.query. */
export function validate(schema: ZodTypeAny, target: "body" | "query" = "body") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(target === "query" ? req.query : req.body);
    if (!result.success) {
      res.status(400).json({
        error: "validation_error",
        details: result.error.flatten(),
      });
      return;
    }

    if (target === "query") {
      res.locals.query = result.data;
    } else {
      req.body = result.data;
    }
    next();
  };
}
