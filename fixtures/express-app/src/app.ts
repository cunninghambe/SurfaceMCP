import express from 'express';
import { z } from 'zod';

const app = express();
app.use(express.json());

const productSchema = z.object({
  name: z.string().min(1).max(200),
  price: z.number().min(0),
  category: z.string().optional(),
});

app.get('/api/products', (_req, res) => {
  res.json({ products: [] });
});

app.post('/api/products', (req, res) => {
  const parsed = productSchema.parse(req.body);
  res.status(201).json({ product: parsed });
});

app.get('/api/products/:id', (req, res) => {
  res.json({ product: { id: req.params.id } });
});

app.put('/api/products/:id', (req, res) => {
  const parsed = productSchema.partial().parse(req.body);
  res.json({ product: { id: req.params.id, ...parsed } });
});

app.delete('/api/products/:id', (req, res) => {
  res.json({ deleted: req.params.id });
});

export { app };
