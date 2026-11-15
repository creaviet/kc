'use strict';

/* ==========================================================================
 *  LOCAL RUNNER for the Lambda handler
 * ==========================================================================
 *  AWS Lambda receives an API Gateway (payload v2) event. This tiny HTTP server
 *  builds exactly that event shape and forwards it to `handler.handler`, so the
 *  same code runs locally (docker compose) and on AWS without a shim library.
 *
 *  It is NOT part of the Lambda deployment package.
 * ========================================================================== */

const http = require('node:http');
const { handler } = require('./handler');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let body = '';
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(err.statusCode || 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'body_too_large' }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const event = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.searchParams.toString(),
    headers: req.headers,
    requestContext: {
      http: { method: req.method, path: url.pathname, protocol: 'HTTP/1.1', sourceIp: req.socket.remoteAddress },
    },
    body,
    isBase64Encoded: false,
  };

  try {
    const result = await handler(event, {});
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'request',
        method: req.method,
        path: url.pathname,
        status: result.statusCode,
        ms: Date.now() - started,
      })
    );
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'handler crashed', error: err.message }));
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server_error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ level: 'info', msg: `portal-api listening on ${HOST}:${PORT}` }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
