import { createServer, Server, ServerResponse } from 'node:http';
import { createServer as netCreateServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { GameStore } from './store.js';
import { RuleError } from './rules.js';

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function startServer(store: GameStore, port: number): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/health') {
        send(res, 200, { ok: true });
        return;
      }

      const body = await readJson(req);

      if (req.method === 'POST' && path === '/api/games') {
        const id = store.createGame(body);
        send(res, 201, { gameId: id, state: store.getState(id) });
        return;
      }

      const stateMatch = path.match(/^\/api\/games\/(\d+)\/state$/);
      if (req.method === 'GET' && stateMatch) {
        const id = Number(stateMatch[1]);
        const showHands = url.searchParams.get('hideHands') === '1' ? false : undefined;
        send(res, 200, store.getState(id, { showHands }));
        return;
      }

      const legalMatch = path.match(/^\/api\/games\/(\d+)\/legal$/);
      if (req.method === 'GET' && legalMatch) {
        const state = store.getState(Number(legalMatch[1]));
        send(res, 200, { turn: state.turn, leadSuit: state.current.leadSuit, legalPlays: state.legalPlays });
        return;
      }

      const playMatch = path.match(/^\/api\/games\/(\d+)\/plays$/);
      if (req.method === 'POST' && playMatch) {
        const id = Number(playMatch[1]);
        const result = store.play(id, (body as any).seat, (body as any).card, (body as any).requestId);
        send(res, result.idempotent ? 200 : 201, {
          idempotent: result.idempotent,
          state: result.state,
        });
        return;
      }

      const tricksMatch = path.match(/^\/api\/games\/(\d+)\/tricks$/);
      if (req.method === 'GET' && tricksMatch) {
        const state = store.getState(Number(tricksMatch[1]));
        send(res, 200, { completedTricks: state.completedTricks, tricks: state.tricks });
        return;
      }

      const replayMatch = path.match(/^\/api\/games\/(\d+)\/replay$/);
      if (req.method === 'POST' && replayMatch) {
        send(res, 200, store.replay(Number(replayMatch[1])));
        return;
      }

      const exportMatch = path.match(/^\/api\/games\/(\d+)\/export$/);
      if (req.method === 'GET' && exportMatch) {
        send(res, 200, store.exportGame(Number(exportMatch[1])));
        return;
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `未知接口 ${req.method} ${path}` } });
    } catch (err) {
      handleError(res, err);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({ server, port: actual });
    });
  });
}

function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new RuleError('BODY_TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (data.length === 0) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new RuleError('INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', () => reject(new RuleError('BAD_REQUEST', '读取请求体失败')));
  });
}

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  GAME_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  GAME_OVER: 409,
  NOT_YOUR_TURN: 409,
  MUST_FOLLOW_SUIT: 422,
  CARD_NOT_IN_HAND: 422,
};

function handleError(res: import('node:http').ServerResponse, err: unknown): void {
  if (err instanceof RuleError) {
    const status = STATUS_BY_CODE[err.code] ?? 400;
    send(res, status, { error: { code: err.code, message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  send(res, 500, { error: { code: 'INTERNAL', message } });
}
