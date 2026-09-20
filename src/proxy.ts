/**
 * Wire-tap: a transparent HTTP proxy sitting between the client and the agent.
 * Prints raw requests and responses, SSE frames included — so you see the protocol
 * rather than the SDK's rendering of it.
 */
import http from 'node:http';

const TARGET_PORT = Number(process.env.TARGET_PORT ?? 41241);
const PORT = Number(process.env.PORT ?? 41242);
// Loopback by default, for the reason the agent itself binds there: the tap is a second
// door into an A2A server that runs `UserBuilder.noAuthentication`, and it forwards
// everything it is given. Set HOST explicitly to open it up.
const HOST = process.env.HOST || '127.0.0.1';
// 127.0.0.1 rather than `localhost`, which can resolve to ::1 while the agent listens on
// IPv4 only — the default the agent now has.
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const pretty = (raw: string) => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      console.log(`\n\x1b[36m→ ${req.method} ${req.url}\x1b[0m`);
      if (body.length) console.log(pretty(body.toString()));

      const upstream = http.request(
        {
          host: TARGET_HOST,
          port: TARGET_PORT,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
        },
        (up) => {
          console.log(`\x1b[32m← ${up.statusCode} ${up.headers['content-type'] ?? ''}\x1b[0m`);
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.on('data', (c: Buffer) => {
            process.stdout.write(dim(c.toString()));
            res.write(c);
          });
          up.on('end', () => {
            process.stdout.write('\n');
            res.end();
          });
        },
      );
      upstream.on('error', (e) => {
        console.error('upstream error:', e.message);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(body);
    });
  })
  .listen(PORT, HOST, () =>
    console.log(`wire-tap listening on ${HOST}:${PORT} → agent on ${TARGET_HOST}:${TARGET_PORT}\n`),
  );
