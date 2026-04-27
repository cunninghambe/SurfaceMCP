import { Router } from 'express';

const subRouter = Router();
subRouter.get('/list', (_req, res) => res.json([]));

export { subRouter };
