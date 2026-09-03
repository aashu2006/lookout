import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Wraps an async route handler so a rejected promise is forwarded to next(err). */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
