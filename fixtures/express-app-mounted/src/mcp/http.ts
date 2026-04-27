import express from 'express';
import { subRouter } from './sub.js';

const router = express.Router();

router.post('/', (_req, res) => res.json({}));
router.get('/', (_req, res) => res.json({}));
router.delete('/', (_req, res) => res.json({}));
router.use('/sub', subRouter);

export { router as mcpRouter };
