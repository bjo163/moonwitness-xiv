import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

const clamdPort = Number(process.argv[2] ?? process.env.MW_E2E_CLAMAV_PORT ?? 3312);
const healthPort = Number(process.argv[3] ?? process.env.MW_E2E_CLAMAV_HEALTH_PORT ?? 3313);

const clamd = createTcpServer((socket) => {
  let buffer = Buffer.alloc(0);
  let command = null;
  let remaining = null;
  let scanning = false;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      if (command === null) {
        const terminator = buffer.indexOf(0);
        if (terminator < 0) return;
        command = buffer.subarray(0, terminator).toString('utf8');
        buffer = buffer.subarray(terminator + 1);
        if (command === 'zPING') {
          socket.write('PONG\0');
          command = null;
          continue;
        }
        if (command !== 'zINSTREAM') {
          socket.destroy(new Error('Unsupported mock clamd command'));
          return;
        }
        scanning = true;
      }

      if (remaining === null) {
        if (buffer.length < 4) return;
        remaining = buffer.readUInt32BE(0);
        buffer = buffer.subarray(4);
        if (remaining === 0) {
          if (scanning) socket.end('stream: OK\0');
          return;
        }
      }

      const consumed = Math.min(remaining, buffer.length);
      remaining -= consumed;
      buffer = buffer.subarray(consumed);
      if (remaining > 0) return;
      remaining = null;
    }
  });
});

const health = createHttpServer((request, response) => {
  if (request.url === '/readyz') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ready');
    return;
  }
  response.writeHead(404).end();
});

clamd.listen(clamdPort, '127.0.0.1');
health.listen(healthPort, '127.0.0.1');

function shutdown() {
  clamd.close();
  health.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
