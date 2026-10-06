import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';

function isBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; cause?: unknown };
  return candidate.code === 'SQLITE_BUSY' || candidate.code === 'SQLITE_BUSY_SNAPSHOT' || (candidate.cause !== undefined && isBusy(candidate.cause));
}
export function createErrorHandler(log: (error: unknown) => void = console.error): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.issues } });
    } else if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
    } else if (isBusy(error)) {
      res.set('Retry-After', '1').status(503).json({ error: { code: 'DATABASE_BUSY', message: 'Database is busy; retry the request' } });
    } else if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } });
    } else if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body exceeds 16kb' } });
    } else {
      log(error);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
  };
}

