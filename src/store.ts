import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.js';
import {
  Card,
  Play,
  RuleError,
  Trump,
  cardId,
  deriveState,
  explainCard,
  parseCard,
  validateDeal,
} from './rules.js';

interface GameRow {
  id: number;
  leader: number;
  trump: string | null;
  total_tricks: number;
}
interface HandRow {
  seat: number;
  ord: number;
  suit: string;
  rank: string;
}
interface EventRow {
  seq: number;
  seat: number;
  suit: string;
  rank: string;
  request_id: string;
}

export class GameStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
  }

  close(): void {
    this.db.close();
  }

  createGame(input: unknown): number {
    const { hands, leader, trump } = validateDeal(input);
    const insertGame = this.db.prepare(
      'INSERT INTO games (leader, trump, total_tricks, created_at) VALUES (?, ?, ?, ?)',
    );
    const insertHand = this.db.prepare(
      'INSERT INTO initial_hands (game_id, seat, ord, suit, rank) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this.db.exec.bind(this.db);
    tx('BEGIN IMMEDIATE');
    try {
      const info = insertGame.run(leader, trump, hands[0].length, new Date().toISOString());
      const id = Number(info.lastInsertRowid);
      hands.forEach((hand, seat) => {
        hand.forEach((card, ord) => insertHand.run(id, seat, ord, card.suit, card.rank));
      });
      tx('COMMIT');
      return id;
    } catch (err) {
      tx('ROLLBACK');
      throw err;
    }
  }

  private loadGame(id: number): { leader: number; trump: Trump; totalTricks: number } {
    const row = this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
    if (!row) throw new RuleError('GAME_NOT_FOUND', `局号 ${id} 不存在`);
    return { leader: row.leader, trump: row.trump as Trump, totalTricks: row.total_tricks };
  }

  private loadHands(id: number): Card[][] {
    const rows = this.db
      .prepare('SELECT * FROM initial_hands WHERE game_id = ? ORDER BY seat, ord')
      .all(id) as unknown as HandRow[];
    const hands: Card[][] = [[], [], [], []];
    for (const row of rows) {
      hands[row.seat].push({ suit: row.suit as Card['suit'], rank: row.rank as Card['rank'] });
    }
    if (hands.some((h) => h.length === 0)) {
      throw new RuleError('CORRUPT_STATE', `局 ${id} 的初始手牌数据不完整`);
    }
    return hands;
  }

  private loadEvents(id: number): Play[] {
    const rows = this.db
      .prepare('SELECT * FROM play_events WHERE game_id = ? ORDER BY seq')
      .all(id) as unknown as EventRow[];
    return rows.map((r) => ({
      seat: r.seat,
      card: { suit: r.suit as Card['suit'], rank: r.rank as Card['rank'] },
    }));
  }

  /** 读模型：手牌、当前墩、历史墩、轮次、各候选牌解释。 */
  getState(id: number, opts: { showHands?: boolean } = {}) {
    const meta = this.loadGame(id);
    const hands = this.loadHands(id);
    const events = this.loadEvents(id);
    const state = deriveState(hands, meta.leader, meta.trump, events);

    let legal: ReturnType<typeof explainCard>[] = [];
    if (!state.over) {
      const hand = state.remaining[state.turn];
      legal = hand.map((card) => explainCard(card, hand, state.current.leadSuit));
    }

    return {
      gameId: id,
      trump: meta.trump,
      totalTricks: meta.totalTricks,
      turn: state.turn,
      over: state.over,
      current: {
        leader: state.current.leader,
        leadSuit: state.current.leadSuit,
        plays: state.current.plays.map((p) => ({ seat: p.seat, card: cardId(p.card) })),
      },
      wins: state.wins,
      winsTotal: state.wins.reduce((a, b) => a + b, 0),
      completedTricks: state.completed.length,
      remaining:
        opts.showHands === false
          ? undefined
          : state.remaining.map((h) => h.map(cardId)),
      legalPlays: legal,
      tricks: state.completed.map((t) => ({
        index: t.index,
        leader: t.leader,
        leadSuit: t.leadSuit,
        plays: t.plays.map((p) => ({ seat: p.seat, card: cardId(p.card) })),
        winner: t.winner,
        winningCard: cardId(t.winningCard),
        reason: t.reason,
      })),
    };
  }

  /**
   * 原子出牌：整墩判定 + 写事件在一个 IMMEDIATE 事务中完成。
   * 非法动作在事务内抛错并回滚，不消耗牌、不推进轮次。
   * requestId 相同且内容一致 -> 幂等返回；内容不同 -> 冲突。
   */
  play(gameId: number, seat: number, cardRaw: unknown, requestId: unknown) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new RuleError('INVALID_REQUEST_ID', '必须提供非空字符串 requestId 用于重试去重');
    }
    if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat > 3) {
      throw new RuleError('INVALID_SEAT', '出牌者 seat 必须是 0..3 的整数');
    }
    const card = parseCard(cardRaw);

    const exec = this.db.exec.bind(this.db);
    exec('BEGIN IMMEDIATE');
    try {
      const meta = this.loadGame(gameId);
      const hands = this.loadHands(gameId);
      const events = this.loadEvents(gameId);
      const state = deriveState(hands, meta.leader, meta.trump, events);

      // 幂等：同一 requestId 已存在
      const prior = this.db
        .prepare('SELECT seat, suit, rank FROM play_events WHERE game_id = ? AND request_id = ?')
        .get(gameId, requestId) as { seat: number; suit: string; rank: string } | undefined;
      if (prior) {
        const same = prior.seat === seat && prior.suit === card.suit && prior.rank === card.rank;
        exec('ROLLBACK');
        if (!same) {
          throw new RuleError(
            'IDEMPOTENCY_CONFLICT',
            `请求编号 ${requestId} 已用于不同出牌（座位 ${prior.seat} 出 ${prior.suit}${prior.rank}），与本次（座位 ${seat} 出 ${cardId(card)}）冲突`,
          );
        }
        return { idempotent: true as const, state: this.getState(gameId) };
      }

      if (state.over) {
        exec('ROLLBACK');
        throw new RuleError('GAME_OVER', `局 ${gameId} 已结束，不能再出牌`);
      }
      if (seat !== state.turn) {
        exec('ROLLBACK');
        throw new RuleError('NOT_YOUR_TURN', `还没轮到座位 ${seat}，当前应轮到座位 ${state.turn}`);
      }
      const hand = state.remaining[seat];
      const idx = hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
      if (idx === -1) {
        exec('ROLLBACK');
        throw new RuleError('CARD_NOT_IN_HAND', `座位 ${seat} 手中没有 ${cardId(card)}`);
      }
      const legality = explainCard(card, hand, state.current.leadSuit);
      if (!legality.legal) {
        exec('ROLLBACK');
        throw new RuleError('MUST_FOLLOW_SUIT', legality.reason);
      }

      const seq = events.length;
      this.db
        .prepare(
          'INSERT INTO play_events (game_id, seq, seat, suit, rank, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(gameId, seq, seat, card.suit, card.rank, requestId, new Date().toISOString());
      exec('COMMIT');
      return { idempotent: false as const, state: this.getState(gameId) };
    } catch (err) {
      // 只有仍在事务中才回滚（幂等分支已自行回滚）
      try {
        exec('ROLLBACK');
      } catch {
        /* 已回滚则忽略 */
      }
      throw err;
    }
  }

  /** 仅从初始发牌 + 成功事件重放并校验，不写入任何新事件。 */
  replay(id: number) {
    const meta = this.loadGame(id);
    const hands = this.loadHands(id);
    const events = this.loadEvents(id);
    const before = this.getState(id);
    const state = deriveState(hands, meta.leader, meta.trump, events);
    const after = this.getState(id);
    return {
      gameId: id,
      replayedEvents: events.length,
      completedTricks: state.completed.length,
      over: state.over,
      consistent: JSON.stringify(before) === JSON.stringify(after),
      note: '重放仅读取不可变初始手牌与 play_events 重新推导，未写入任何新事件',
    };
  }

  /** 导出不可变记录：初始规则/手牌 + 出牌事件。 */
  exportGame(id: number) {
    const meta = this.loadGame(id);
    const hands = this.loadHands(id);
    const eventRows = this.db
      .prepare('SELECT seq, seat, suit, rank, request_id FROM play_events WHERE game_id = ? ORDER BY seq')
      .all(id) as Array<{ seq: number; seat: number; suit: string; rank: string; request_id: string }>;
    return {
      gameId: id,
      rules: { leader: meta.leader, trump: meta.trump, totalTricks: meta.totalTricks },
      initialHands: hands.map((h) => h.map(cardId)),
      events: eventRows.map((r) => ({
        seq: r.seq,
        seat: r.seat,
        card: r.suit + r.rank,
        requestId: r.request_id,
      })),
    };
  }
}
