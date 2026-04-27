import { Router } from 'express';

const router = Router();

router.get('/health', (_req, res) => res.json({ ok: true }));
router.post('/trades', (_req, res) => res.json({}));
router.post('/trades/batch', (_req, res) => res.json({}));
router.get('/trades/:trade_id', (_req, res) => res.json({}));
router.post('/summaries/daily', (_req, res) => res.json({}));

export default router;
