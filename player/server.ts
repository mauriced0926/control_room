// HTTP for the fixture player: serves the Overview (src/ui/) and streams frames to it. Listens on
// localhost only. The browser's controls change what is replayed; nothing is ever sent to a gateway.
//
// No build step (task 6a): the browser imports the TypeScript modules in src/ directly, and this
// server strips their types on the way out with Node's module.stripTypeScriptTypes.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, TimerHandle } from '../src/clock.ts';
import { listFixtures, Player, type Frame } from './player.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const INDEX = 'ui/index.html';
const TICK_MS = 200; // frames while playing: 5 per second, the rate trucks report at
const IDLE_FRAME_MS = 1_000; // frames while paused, so the browser can tell the player is still there

const TYPES: Record<string, string> = {
  '.ts': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// stripTypeScriptTypes is marked experimental and warns once per process. The player is a dev tool;
// this one warning is dropped so the console shows only what matters. Any other warning still prints.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(typeof w === 'string' ? w : w.message).includes('stripTypeScriptTypes')) return;
  (emitWarning as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

export interface PlayerServer {
  url: string;
  player: Player;
  close(): Promise<void>;
}

export async function startPlayerServer(opts: { clock: Clock; fixture: string; port?: number; playing?: boolean }): Promise<PlayerServer> {
  const { clock } = opts;
  const player = new Player(opts.fixture);
  if (opts.playing) player.play();
  const streams = new Set<ServerResponse>();
  let lastWall = clock.now();
  let lastSent = -Infinity;
  let timer: TimerHandle | null = null;

  const send = (f: Frame) => {
    const data = `data: ${JSON.stringify(f)}\n\n`;
    for (const s of streams) s.write(data);
    lastSent = clock.now();
  };
  const loop = () => {
    const now = clock.now();
    player.advanceWall(now - lastWall);
    lastWall = now;
    if (player.playing || now - lastSent >= IDLE_FRAME_MS) send(player.frame());
    timer = clock.setTimeout(loop, TICK_MS);
  };
  timer = clock.setTimeout(loop, TICK_MS);

  const control = (body: Record<string, unknown>) => {
    switch (body.op) {
      case 'load': player.load(String(body.fixture)); break;
      case 'play': player.play(); break;
      case 'pause': player.pause(); break;
      case 'seek': player.seek(Number(body.offsetMs)); break;
      case 'step': player.step(Number(body.ms)); break;
      case 'next': player.nextEvent(); break;
      case 'speed': player.setSpeed(Number(body.speed)); break;
      default: throw new Error(`unknown op ${String(body.op)}`);
    }
    lastWall = clock.now();
    send(player.frame());
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => reply(res, 500, 'text/plain', String(e instanceof Error ? e.message : e)));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      streams.add(res);
      req.on('close', () => streams.delete(res));
      res.write(`data: ${JSON.stringify(player.frame())}\n\n`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/fixtures') return reply(res, 200, 'application/json', JSON.stringify(listFixtures()));
    if (req.method === 'POST' && url.pathname === '/api/control') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      try { control(body); } catch (e) { return reply(res, 400, 'text/plain', e instanceof Error ? e.message : String(e)); }
      return reply(res, 204, 'text/plain', '');
    }
    if (req.method !== 'GET') return reply(res, 405, 'text/plain', 'method not allowed');
    const rel = url.pathname === '/' ? INDEX : decodeURIComponent(url.pathname).replace(/^\/src\//, '');
    const path = normalize(SRC + rel);
    const type = TYPES[extname(path)];
    if (!path.startsWith(SRC) || path.split(sep).some((p) => p.startsWith('._') || p === '..') || !type) return reply(res, 404, 'text/plain', 'not found');
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch { return reply(res, 404, 'text/plain', 'not found'); }
    if (extname(path) === '.ts') text = stripTypeScriptTypes(text);
    return reply(res, 200, type, text);
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    player,
    close: () => new Promise<void>((resolve) => {
      if (timer) clock.clearTimeout(timer);
      for (const s of streams) s.end();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function reply(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { s += c; if (s.length > 10_000) reject(new Error('body too large')); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}
