import type { NextFunction, Request, Response } from 'express';

/** Route async errors into the shared error handler. */
export const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);
