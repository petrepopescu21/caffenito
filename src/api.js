// HTTP API for the shop status, e.g. for an automation app on the register tablet.
//
//   GET  /api/shop/status   current status (public: the banner shows it anyway)
//   POST /api/shop/status   change it: {"status": "open" | "closed", "note"?: "..."}
//                           Authorization: Bearer <SHOP_API_TOKEN>
//   GET  /openapi.json      OpenAPI 3.1 description of the above
//   GET  /docs              Swagger UI for it
//   GET  /health            for Fly's health check
//
// On Fly this sits behind Fly's HTTPS proxy (fly.toml [http_service]), so the token
// never travels unencrypted.

import http from 'node:http';
import crypto from 'node:crypto';
import { getShopState, setShopStatus } from './shop.js';
import { openapi } from './openapi.js';

const MAX_BODY = 2048;
const MAX_NOTE = 500;
const POSTS_PER_MINUTE = 10; // across all callers; protects Discord from a runaway automation

const recentPosts = [];

function send(res, code, payload, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

function authorized(req, token) {
  const given = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('Body too large.');
  }
  try {
    return JSON.parse(body || 'null');
  } catch {
    throw new Error('Body must be JSON.');
  }
}

const docsPage = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Awake shop API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css">
</head><body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui' });</script>
</body></html>`;

async function handle(req, res, client, config) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, discord: client.isReady() });
  if (req.method === 'GET' && path === '/openapi.json') return send(res, 200, openapi, { 'Access-Control-Allow-Origin': '*' });
  if (req.method === 'GET' && path === '/docs') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(docsPage);
  }
  if (path !== '/api/shop/status') return send(res, 404, { error: 'Not found.' });

  if (req.method === 'GET') return send(res, 200, getShopState(), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' }, { Allow: 'GET, POST' });

  if (!config.shopApiToken) return send(res, 503, { error: 'The API token is not configured on the server.' });
  if (!authorized(req, config.shopApiToken)) {
    return send(res, 401, { error: 'Missing or wrong token. Send Authorization: Bearer <token>.' }, { 'WWW-Authenticate': 'Bearer' });
  }

  const now = Date.now();
  while (recentPosts.length && recentPosts[0] < now - 60_000) recentPosts.shift();
  if (recentPosts.length >= POSTS_PER_MINUTE) return send(res, 429, { error: 'Too many changes; try again in a minute.' }, { 'Retry-After': '60' });
  recentPosts.push(now);

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
  const status = body?.status;
  const note = body?.note;
  if (status !== 'open' && status !== 'closed') return send(res, 400, { error: 'status must be "open" or "closed".' });
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) {
    return send(res, 400, { error: `note must be a string of at most ${MAX_NOTE} characters.` });
  }
  if (!client.isReady()) return send(res, 503, { error: 'The bot is still connecting to Discord; retry in a few seconds.' }, { 'Retry-After': '5' });

  const changed = await setShopStatus(client, config, status, note?.trim() || null, 'API');
  return send(res, 200, { changed, ...getShopState() });
}

export function startApi(client, config) {
  const server = http.createServer((req, res) =>
    handle(req, res, client, config).catch((err) => {
      console.error('API request failed:', err);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
    }),
  );
  server.listen(config.port, () =>
    console.log(`API listening on port ${config.port}${config.shopApiToken ? '' : ' (read-only: SHOP_API_TOKEN not set)'}.`),
  );
}
