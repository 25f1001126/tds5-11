const express = require('express');
const engine = require('./engine');
const { HttpError } = require('./util');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/v2/incidents', async (req, res, next) => {
  try {
    const { status, body } = await engine.createRun(req.body, req.headers);
    send(res, status, body);
  } catch (e) { next(e); }
});

app.post('/v2/incidents/:runId/receipts', async (req, res, next) => {
  try {
    const { status, body } = await engine.processReceipts(req.params.runId, req.body, req.headers);
    send(res, status, body);
  } catch (e) { next(e); }
});

app.get('/v2/incidents/:runId', (req, res, next) => {
  try {
    const { status, body } = engine.getRun(req.params.runId);
    send(res, status, body);
  } catch (e) { next(e); }
});

function send(res, status, body) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > 768 * 1024) {
    return res.status(500).json({ error: 'response exceeds 768 KiB' });
  }
  res.status(status).type('application/json').send(json);
}

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ error: err.message || 'internal error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`incident-agent listening on :${PORT}`));
