import express from 'express';
import { moneybotRouter } from './moneybot/index.js';
import { mcpRouter } from './mcp/http.js';

const app = express();
app.use(express.json());
app.use('/api/v1', moneybotRouter);
app.use('/mcp', mcpRouter);

export { app };
