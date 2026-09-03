import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";

/**
 * Parses a request against `schema`.
 * - target "body": replaces req.body with the parsed value.
 * - target "query": puts the parsed value on res.locals.query, leaving Express's
 *   own req.query untouched (its ParsedQs strings survive; handlers read the
 *   coerced/defaulted copy instead).
 */
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
