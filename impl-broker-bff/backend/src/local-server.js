/**
 * Local development server. It converts a Node request into an API Gateway v2
 * style event so the same handlers run locally and in Lambda.
 *
 * Use INSECURE_COOKIES=true + DEV_PORTAL_HOST=vw-baev.de in .env for HTTP.
 */

import http from 'node:http';
import { route } from './router.js';

const port = Number(process.env.PORT || 3001);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const event = {
      rawPath: url.pathname,
      requestContext: { http: { method: req.method } },
      headers: req.headers,
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
      body: null,
    };

    const result = await route(event);
    res.statusCode = result.statusCode;
    for (const [name, value] of Object.entries(result.headers || {})) {
      res.setHeader(name, value);
    }
    if (result.cookies?.length) res.setHeader('Set-Cookie', result.cookies);
    res.end(result.body || '');
  })
  .listen(port, () => {
    console.log(`BFF listening on http://localhost:${port} (portal: ${process.env.DEV_PORTAL_HOST || 'from Host header'})`);
  });
