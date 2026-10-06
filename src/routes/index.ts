import { Router } from 'express';
import { sqlite } from '../db';

export const router = Router();

router.get('/health', (_req, res) => {
  sqlite.prepare('SELECT 1').get();
  res.json({ status: 'ok' });
});

