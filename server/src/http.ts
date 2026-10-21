import type { NextFunction, Request, Response } from "express";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function fail(message: string, status = 400): never {
  throw new HttpError(status, message);
}

export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function param(req: Request, name: string): string {
  return String(req.params[name] ?? "");
}
