import express from 'express';

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/data', (_req, res) => {
  res.json({ data: {} });
});

export { app };
