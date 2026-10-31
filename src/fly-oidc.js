// Fly.io OIDC tokens, for Claude API Workload Identity Federation.
//
// A Fly machine gets a signed JWT from its local API socket. Each token is valid for
// 10 minutes and Anthropic accepts each one only once (it carries a `jti`), so we mint
// a fresh token for every exchange instead of caching one on disk.

import fs from 'node:fs';
import http from 'node:http';

const SOCKET = '/.fly/api';

export const onFly = () => fs.existsSync(SOCKET);

export function mintFlyToken(audience) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path: '/v1/tokens/oidc', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Fly OIDC endpoint returned ${res.statusCode}: ${body}`));
          resolve(body.trim().replace(/^"|"$/g, ''));
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ aud: audience }));
  });
}
