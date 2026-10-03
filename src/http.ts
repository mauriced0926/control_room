// The service's HTTP side: login, logout, the Overview's files, and the live WebSocket (task 6b).
//
// Every request, the WebSocket included, refuses an unauthenticated user (L8.6). The only things
// served without a session are the login page, its stylesheet, and the login form's POST.
//
// Checks on every request, before anything else:
// - Host must be one of ours (the listen address, localhost, PUBLIC_ORIGIN): a page on another site
//   that rebinds its DNS name to this address gets nothing.
// - Origin, when the browser sends one, must be one of ours; a POST or a WebSocket must send one.
//   With SameSite=Strict cookies this is the cross-site request forgery defence.
//
// No build step (task 6a): the browser imports src/ modules directly; their types are stripped on
// the way out, as the fixture player does.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { Socket } from 'node:net';
import { extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LiveHub } from './live.ts';
import { clearedCookie, LoginThrottle, sessionCookie, sessionIdFrom, type Session, type Sessions } from './sessions.ts';
import type { User, UserBook } from './users.ts';

const SRC = fileURLToPath(new URL('./', import.meta.url));
const PUBLIC_FILES = new Set(['ui/overview.css']);
const LIVE_PATH = '/api/live';
const MAX_FORM_BYTES = 4_096;
const MAX_WS_BYTES = 4_096;

const TYPES: Record<string, string> = {
  '.ts': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Scripts only from here; no inline script anywhere. Inline style attributes are allowed because the
// track diagram positions chips with them.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// stripTypeScriptTypes is marked experimental and warns once per process. This one warning is dropped
// so start-up and the log show only what matters; any other warning still prints.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(typeof w === 'string' ? w : w.message).includes('stripTypeScriptTypes')) return;
  (emitWarning as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

export type AuthEvent =
  | { event: 'login'; user: User; address: string }
  | { event: 'login_failed'; userId: string | null; address: string; throttled: boolean };

export interface HttpOptions {
  host: string;
  port: number;
  publicOrigins: string[];
  users: UserBook;
  sessions: Sessions;
  throttle: LoginThrottle;
  hub: LiveHub;
  onAuth: (e: AuthEvent) => void;
  log: (line: string) => void;
}

export interface HttpServer {
  url: string;
  port: number;
  origins: string[];
  close(): Promise<void>;
}

export async function startHttp(o: HttpOptions): Promise<HttpServer> {
  const files = new Map<string, string>();
  let origins: string[] = [];
  let hosts = new Map<string, boolean>(); // host header -> is https

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES, perMessageDeflate: false, clientTracking: false });

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      o.log(`error serving ${req.method} ${safePath(req)}: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal error');
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    };
    const host = req.headers.host ?? '';
    if (!hosts.has(host)) return refuse(421, 'Misdirected Request');
    const origin = req.headers.origin;
    if (!origin || !origins.includes(origin)) return refuse(403, 'Forbidden');
    const session = o.sessions.get(sessionIdFrom(req.headers.cookie));
    if (!session) return refuse(401, 'Unauthorized');
    if (new URL(req.url ?? '/', 'http://x').pathname !== LIVE_PATH) return refuse(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const live = o.hub.connect({ send: (t) => ws.send(t), close: (c, r) => ws.close(c, r), get bufferedAmount() { return ws.bufferedAmount; } }, session);
      ws.on('message', (data, isBinary) => live.receive(data, isBinary));
      ws.on('close', () => live.closed());
      // ws reports a frame over maxPayload, bad UTF-8 or a protocol error here, then closes the
      // socket itself. Without this listener the error would end the process.
      ws.on('error', (e) => { o.log(`live connection error (${session.user.id}): ${e.message}`); live.closed(); });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (!hosts.has(host)) return send(res, 421, 'text/plain; charset=utf-8', `This service is not set up to be reached as "${host.slice(0, 100)}". Use one of: ${origins.join(', ')}, or add yours to PUBLIC_ORIGIN.`);
    const secure = hosts.get(host)!;
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.includes(origin)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden: request from another site');
    if (req.method === 'POST' && origin === undefined) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden: no Origin header');

    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const session = o.sessions.get(sessionIdFrom(req.headers.cookie));

    // ---- open without a session ----
    if (path === '/login') {
      if (req.method === 'GET') {
        if (session) return redirect(res, '/');
        return send(res, 200, TYPES['.html']!, loginPage(url.searchParams.has('failed') ? 'Login refused. Check the name and password, or wait a few minutes after several tries.' : null));
      }
      if (req.method === 'POST') return login(req, res, secure, session);
      return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    }
    const rel = path.startsWith('/src/') ? safeDecode(path.slice('/src/'.length)) : null;
    if (req.method === 'GET' && rel !== null && PUBLIC_FILES.has(rel)) return file(res, rel);

    // ---- everything else needs a session (L8.6) ----
    if (!session) {
      if (req.method === 'GET' && path === '/') return redirect(res, '/login');
      return send(res, 401, 'text/plain; charset=utf-8', 'Not logged in');
    }
    o.sessions.touch(session.id);

    if (path === '/logout') {
      if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      o.sessions.end(session.id, 'logout'); // audited and its screens closed by the session listeners
      res.setHeader('set-cookie', clearedCookie({ secure }));
      return redirect(res, '/login');
    }
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if (path === '/') return send(res, 200, TYPES['.html']!, livePage());
    if (path === '/api/session') return send(res, 200, 'application/json', JSON.stringify({ user: session.user }));
    if (rel !== null) return file(res, rel);
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  }

  async function login(req: IncomingMessage, res: ServerResponse, secure: boolean, existing: Session | undefined): Promise<void> {
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, 'text/plain; charset=utf-8', 'Unsupported media type');
    const body = await readBody(req, MAX_FORM_BYTES);
    if (body === null) return send(res, 413, 'text/plain; charset=utf-8', 'Too large');
    const form = new URLSearchParams(body);
    const name = (form.get('username') ?? '').trim().toLowerCase().slice(0, 64);
    const password = form.get('password') ?? '';
    const address = clientAddress(req);
    const keys = LoginThrottle.keys(address, name);
    const known = o.users.find(name) ? name : null;
    if (o.throttle.blocked(keys)) {
      o.onAuth({ event: 'login_failed', userId: known, address, throttled: true });
      return redirect(res, '/login?failed');
    }
    const user = await o.users.verify(name, password);
    if (!user) {
      o.throttle.failed(keys);
      o.onAuth({ event: 'login_failed', userId: known, address, throttled: false });
      return redirect(res, '/login?failed');
    }
    o.throttle.succeeded(keys);
    if (existing) o.sessions.end(existing.id, 'logout'); // a new login always gets a new id
    const s = o.sessions.create(user);
    o.onAuth({ event: 'login', user, address });
    res.setHeader('set-cookie', sessionCookie(s.id, { secure, maxAgeMs: o.sessions.maxAgeMs }));
    return redirect(res, '/');
  }

  function file(res: ServerResponse, rel: string): void {
    const p = normalize(SRC + rel);
    const type = TYPES[extname(p)];
    if (!p.startsWith(SRC) || rel.split('/').some((x) => x.startsWith('._') || x === '..' || x === '') || !type) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    let text = files.get(p);
    if (text === undefined) {
      try { text = readFileSync(p, 'utf8'); } catch { return send(res, 404, 'text/plain; charset=utf-8', 'Not found'); }
      if (extname(p) === '.ts') text = stripTypeScriptTypes(text);
      files.set(p, text);
    }
    return send(res, 200, type, text);
  }

  function livePage(): string {
    let t = files.get('live-index');
    if (t === undefined) {
      t = readFileSync(SRC + 'ui/index.html', 'utf8').replace('<body>', '<body data-mode="live">');
      files.set('live-index', t);
    }
    return t;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  origins = ourOrigins(o.host, port, o.publicOrigins);
  hosts = new Map(origins.map((x) => { const u = new URL(x); return [u.host, u.protocol === 'https:'] as const; }));
  const listenHost = o.host === '0.0.0.0' || o.host === '::' ? '127.0.0.1' : o.host;
  return {
    url: `http://${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${port}/`,
    port,
    origins,
    close: () => new Promise<void>((resolve) => {
      o.hub.shutdown();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// The origins a browser may use to reach us: the listen address and its loopback names, plus any
// configured. A wildcard listen address is not a name a browser uses, so it adds nothing itself.
export function ourOrigins(host: string, port: number, extra: string[]): string[] {
  const out = new Set<string>([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  if (host !== '0.0.0.0' && host !== '::') out.add(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`);
  for (const x of extra) out.add(x);
  return [...out];
}

// Behind the reverse proxy every connection comes from loopback; the proxy appends the real address
// to X-Forwarded-For, so the last entry is the one it saw. From anywhere else, the peer itself.
function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const loop = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const xff = req.headers['x-forwarded-for'];
  if (loop && typeof xff === 'string' && xff.trim()) return xff.split(',').at(-1)!.trim().slice(0, 64);
  return peer;
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { location: to, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end();
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return ''; } // '' is never a file: a 404
}

function safePath(req: IncomingMessage): string {
  return (req.url ?? '').split('?')[0]!.slice(0, 100);
}

function loginPage(error: string | null): string {
  const page = readFileSync(SRC + 'ui/login.html', 'utf8');
  return page.replace('<!--error-->', error ? `<p class="login-error" role="alert">${error}</p>` : '');
}
