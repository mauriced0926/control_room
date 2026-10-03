// Run the fake gateway over TLS on the real clock, for research/probe.py and by-hand checks.
//
//   openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 \
//     -addext subjectAltName=IP:127.0.0.1 -keyout key.pem -out cert.pem
//   node fake/main.ts --key key.pem --cert cert.pem [--port 7443] [--seed 1] [--blasts random|none]
//                     [--fault <vehicle>:<code> ...] [--day live|perfect]
// --day live switches on every injector of a live day (fake/faults.ts LIVE_DAY); the default is perfect.
//
// Then point a client at it with GATEWAY_HOST=127.0.0.1, GATEWAY_PORT and SSL_CERT_FILE=cert.pem.
// The default site is DLH-1 (fake/dlh1.ts). Never point a probe at the real gateway by accident:
// this prints the address it serves.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SystemClock } from '../src/clock.ts';
import { FakeGateway } from './gateway.ts';
import { DLH1 } from './dlh1.ts';
import { listenTls } from './tls.ts';
import { LIVE_DAY } from './faults.ts';

const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    cert: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '0' },
    seed: { type: 'string', default: '1' },
    blasts: { type: 'string', default: 'random' },
    fault: { type: 'string', multiple: true, default: [] },
    day: { type: 'string', default: 'perfect' },
  },
});
if (!values.key || !values.cert) {
  console.error('usage: node fake/main.ts --key key.pem --cert cert.pem [--port N] [--seed N] [--blasts random|none] [--fault VEHICLE:CODE]');
  process.exit(2);
}
if (values.blasts !== 'random' && values.blasts !== 'none') {
  console.error(`--blasts must be random or none, not ${values.blasts}`);
  process.exit(2);
}

if (values.day !== 'live' && values.day !== 'perfect') {
  console.error(`--day must be live or perfect, not ${values.day}`);
  process.exit(2);
}
const gw = new FakeGateway(new SystemClock(), { seed: Number(values.seed), site: DLH1, blasts: values.blasts, ...(values.day === 'live' ? { faults: LIVE_DAY } : {}) });
for (const f of values.fault) {
  const [vehicle, code] = f.split(':');
  if (!vehicle || !code) { console.error(`--fault wants VEHICLE:CODE, not ${f}`); process.exit(2); }
  gw.injectFault(vehicle, code);
}
gw.start();
const server = await listenTls(gw, { key: readFileSync(values.key), cert: readFileSync(values.cert), host: values.host, port: Number(values.port) });
console.log(`fake gateway (site ${DLH1.site_id}, seed ${values.seed}) listening on ${values.host}:${server.port}`);

const shutdown = () => { gw.stop(); void server.close().then(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
