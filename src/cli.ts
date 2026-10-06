#!/usr/bin/env node
import { resolve } from 'node:path';
import { GameStore } from './store.js';
import { RuleError } from './rules.js';
import { findFreePort, startServer } from './server.js';
import { runDemo } from './demo.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = 'true';
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function dbPath(flags: Record<string, string>): string {
  return resolve(flags.db ?? process.env.TRICKSTER_DB ?? 'data/games.db');
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function fail(err: unknown): never {
  if (err instanceof RuleError) {
    console.error(`错误 [${err.code}] ${err.message}`);
  } else {
    console.error('错误', err);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.command;

  if (cmd === 'demo') {
    const store = new GameStore(resolve(args.flags.db ?? 'data/demo.db'));
    try {
      await runDemo(store);
    } finally {
      store.close();
    }
    return;
  }

  if (cmd === 'serve') {
    const store = new GameStore(dbPath(args.flags));
    const requested = args.flags.port ? Number(args.flags.port) : 0;
    if (Number.isNaN(requested)) throw new Error('--port 必须是数字');
    const port = requested === 0 ? await findFreePort() : requested;
    const { server } = await startServer(store, port);
    const actual = (server.address() as { port: number }).port;
    console.log(`吃墩规则服务已启动: http://127.0.0.1:${actual}`);
    console.log(`数据库: ${dbPath(args.flags)}`);
    const shutdown = () => {
      server.close(() => {
        store.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const store = new GameStore(dbPath(args.flags));
  try {
    switch (cmd) {
      case 'create': {
        if (!args.flags.hands) throw new RuleError('MISSING_PARAM', '需要 --hands JSON，例如 --hands \'[["H10",...],...]\'');
        if (args.flags.leader === undefined) throw new RuleError('MISSING_PARAM', '需要 --leader 0..3');
        if (args.flags.trump === undefined) throw new RuleError('MISSING_PARAM', '需要 --trump S/H/D/C 或 NT');
        let hands: unknown;
        try {
          hands = JSON.parse(args.flags.hands);
        } catch {
          throw new RuleError('INVALID_JSON', '--hands 不是合法 JSON');
        }
        const id = store.createGame({
          hands,
          leader: Number(args.flags.leader),
          trump: args.flags.trump,
        });
        print({ gameId: id, state: store.getState(id) });
        break;
      }
      case 'state': {
        const id = requireId(args.positional);
        print(store.getState(id, { showHands: args.flags['hide-hands'] ? false : undefined }));
        break;
      }
      case 'legal': {
        const id = requireId(args.positional);
        const state = store.getState(id);
        print({ turn: state.turn, leadSuit: state.current.leadSuit, legalPlays: state.legalPlays });
        break;
      }
      case 'play': {
        const id = requireId(args.positional);
        if (args.flags.seat === undefined) throw new RuleError('MISSING_PARAM', '需要 --seat 0..3');
        if (!args.flags.card) throw new RuleError('MISSING_PARAM', '需要 --card，例如 --card H10');
        if (!args.flags['request-id']) throw new RuleError('MISSING_PARAM', '需要 --request-id 用于重试去重');
        const result = store.play(
          id,
          Number(args.flags.seat),
          args.flags.card,
          args.flags['request-id'],
        );
        print({ idempotent: result.idempotent, state: result.state });
        break;
      }
      case 'tricks': {
        const id = requireId(args.positional);
        const state = store.getState(id);
        print({ completedTricks: state.completedTricks, tricks: state.tricks });
        break;
      }
      case 'replay': {
        const id = requireId(args.positional);
        print(store.replay(id));
        break;
      }
      case 'export': {
        const id = requireId(args.positional);
        print(store.exportGame(id));
        break;
      }
      default:
        printUsage();
        process.exit(cmd ? 1 : 0);
      }
  } finally {
    store.close();
  }
}

function requireId(positional: string[]): number {
  const id = Number(positional[0]);
  if (!Number.isInteger(id)) {
    throw new RuleError('MISSING_PARAM', '需要局号，例如 state 3');
  }
  return id;
}

function printUsage(): void {
  console.log(`用法: trickster <命令> [参数]

命令:
  serve [--port 端口(默认自动选空闲端口)] [--db data/games.db]
  create --hands '[[4个座位的牌]]' --leader 0..3 --trump S|H|D|C|NT
  state <局号> [--hide-hands]        查看手牌与局面
  legal <局号>                      当前轮次、引领花色、每张候选牌可出原因
  play <局号> --seat 0..3 --card H10 --request-id 唯一编号
  tricks <局号>                     已结束墩的出牌顺序、比较与赢家
  replay <局号>                     从初始发牌与成功事件重放核验（不写入）
  export <局号>                     导出不可变初始手牌、规则与事件
  demo [--db data/demo.db]          运行内置演示局

环境变量: TRICKSTER_DB 可覆盖默认数据库路径`);
}

main().catch(fail);
