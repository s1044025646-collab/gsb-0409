import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { GameStore } from '../src/store.js';
import { RuleError, cardId, deriveState, parseCard, settleTrick, validateDeal } from '../src/rules.js';

const TWO_CARD_HANDS = [
  ['H10', 'S2'],
  ['H2', 'S4'],
  ['S3', 'D4'],
  ['HA', 'D5'],
];

function tmpDb(name: string): string {
  return join(tmpdir(), `trickster-test-${name}-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof RuleError && err.code === code);
}

test('无将局：最大引领花色牌获胜，异花色非将牌不能赢', () => {
  const db = tmpDb('nt');
  const store = new GameStore(db);
  const id = store.createGame({ hands: TWO_CARD_HANDS, leader: 0, trump: 'NT' });
  // 第一墩 H10 H2 S3 HA：无将时 HA 胜（S3 虽是黑桃但无将，不赢）
  store.play(id, 0, 'H10', 'r0');
  store.play(id, 1, 'H2', 'r1');
  store.play(id, 2, 'S3', 'r2');
  store.play(id, 3, 'HA', 'r3');
  let state = store.getState(id);
  assert.equal(state.tricks[0].winner, 3);
  assert.equal(state.current.leader, 3);
  // 第二墩：座位3 D5 领出，座位0 无方块垫 S2，座位1 垫 S4，座位2 D4 跟牌 -> D5 最大，座位3 再赢
  store.play(id, 3, 'D5', 'r4');
  store.play(id, 0, 'S2', 'r5');
  store.play(id, 1, 'S4', 'r6');
  store.play(id, 2, 'D4', 'r7');
  state = store.getState(id);
  assert.equal(state.over, true);
  assert.equal(state.turn, -1);
  assert.deepEqual(state.wins, [0, 0, 0, 2]);
  assert.equal(state.winsTotal, 2);
  store.close();
  rmSync(db, { force: true });
});

test('将牌领出与多个将牌：最大将牌获胜', () => {
  const db = tmpDb('trump');
  const store = new GameStore(db);
  const id = store.createGame({ hands: TWO_CARD_HANDS, leader: 0, trump: 'S' });
  // 墩1 引领花色即黑桃（将牌领出），多张将牌 S2 S4 S3 中最大为 S4 -> 座位1 赢
  store.play(id, 0, 'S2', 't0');
  // 将牌领出，座位1/2 仍有黑桃必须跟；试图出红桃被拒
  expectCode(() => store.play(id, 1, 'H2', 't1-bad'), 'MUST_FOLLOW_SUIT');
  store.play(id, 1, 'S4', 't1');
  expectCode(() => store.play(id, 2, 'D4', 't2-bad'), 'MUST_FOLLOW_SUIT');
  store.play(id, 2, 'S3', 't2');
  store.play(id, 3, 'HA', 't3-fixed');
  const state = store.getState(id);
  assert.equal(state.tricks[0].winner, 1);
  assert.match(state.tricks[0].reason, /最大将牌 S4/);
  store.close();
  rmSync(db, { force: true });
});

test('将吃：非将领出时最大将牌获胜（演示核心）', () => {
  const db = tmpDb('ruff');
  const store = new GameStore(db);
  const hands = [
    ['H10', 'C2'],
    ['H2', 'C3'],
    ['S3', 'C4'],
    ['HA', 'D5'],
  ];
  const id = store.createGame({ hands, leader: 0, trump: 'S' });
  store.play(id, 0, 'H10', 'x0');
  store.play(id, 1, 'H2', 'x1');
  store.play(id, 2, 'S3', 'x2');
  store.play(id, 3, 'HA', 'x3');
  const state = store.getState(id);
  assert.equal(state.tricks[0].winner, 2); // S3 将吃，尽管 HA 点数更大
  assert.match(state.tricks[0].reason, /S3/);
  store.close();
  rmSync(db, { force: true });
});

test('错误玩家、非法动作不消耗牌不推进轮次', () => {
  const db = tmpDb('turn');
  const store = new GameStore(db);
  const id = store.createGame({ hands: TWO_CARD_HANDS, leader: 0, trump: 'S' });
  expectCode(() => store.play(id, 1, 'S4', 'w0'), 'NOT_YOUR_TURN');
  expectCode(() => store.play(id, 0, 'H2', 'w1'), 'CARD_NOT_IN_HAND');
  // 座位0 领出前可任意出；先领红桃，再测座位1 有红桃却出黑桃
  store.play(id, 0, 'H10', 'w2');
  expectCode(() => store.play(id, 1, 'S4', 'w3'), 'MUST_FOLLOW_SUIT');
  const state = store.getState(id);
  // 被拒后仍轮到座位1，且当前墩只有座位0的一张，手牌未被消耗
  assert.equal(state.turn, 1);
  assert.equal(state.current.plays.length, 1);
  assert.ok(state.remaining![1].includes('S4'));
  assert.ok(state.remaining![1].includes('H2'));
  const legal = state.legalPlays.find((c) => c.card === 'S4')!;
  assert.equal(legal.legal, false);
  assert.match(legal.reason, /必须跟同花色/);
  assert.equal(state.legalPlays.find((c) => c.card === 'H2')!.legal, true);
  store.close();
  rmSync(db, { force: true });
});

test('重复请求幂等，同编号不同内容冲突', () => {
  const db = tmpDb('idem');
  const store = new GameStore(db);
  const id = store.createGame({ hands: TWO_CARD_HANDS, leader: 0, trump: 'S' });
  const first = store.play(id, 0, 'S2', 'REQ-1');
  assert.equal(first.idempotent, false);
  const retry = store.play(id, 0, 'S2', 'REQ-1');
  assert.equal(retry.idempotent, true);
  assert.equal(store.exportGame(id).events.length, 1);
  expectCode(() => store.play(id, 0, 'H10', 'REQ-1'), 'IDEMPOTENCY_CONFLICT');
  expectCode(() => store.play(id, 0, 'S2', ''), 'INVALID_REQUEST_ID');
  store.close();
  rmSync(db, { force: true });
});

test('校验：人数错误、手牌不等、跨手牌重复卡、未知花色点数', () => {
  expectCode(() => validateDeal({ hands: [['H2'], ['H3'], ['H4']], leader: 0, trump: 'S' }), 'PLAYER_COUNT');
  expectCode(
    () => validateDeal({ hands: [['H2'], ['H3', 'H4'], ['H5'], ['H6']], leader: 0, trump: 'S' }),
    'UNEQUAL_HANDS',
  );
  expectCode(
    () => validateDeal({ hands: [['H2'], ['H2'], ['H3'], ['H4']], leader: 0, trump: 'S' }),
    'DUPLICATE_CARD',
  );
  expectCode(() => parseCard('X2'), 'UNKNOWN_SUIT');
  expectCode(() => parseCard('H1'), 'UNKNOWN_RANK');
  expectCode(() => validateDeal({ hands: TWO_CARD_HANDS, leader: 5, trump: 'S' }), 'INVALID_LEADER');
  expectCode(() => validateDeal({ hands: TWO_CARD_HANDS, leader: 0, trump: 'X' }), 'UNKNOWN_TRUMP');
});

test('不变式：初始牌集 = 剩余手牌 + 当前墩 + 历史墩；重放与重启一致', () => {
  const db = tmpDb('restart');
  let store = new GameStore(db);
  const id = store.createGame({ hands: TWO_CARD_HANDS, leader: 0, trump: 'S' });
  const moves: Array<[number, string]> = [
    [0, 'S2'], [1, 'S4'], [2, 'S3'], [3, 'HA'],
    [1, 'H2'], [2, 'D4'], [3, 'D5'], [0, 'H10'],
  ];
  moves.forEach(([seat, card], i) => store.play(id, seat, card, `m${i}`));
  const before = store.getState(id);
  const initialSet = TWO_CARD_HANDS.flat().sort();
  const accounted = [
    ...(before.remaining ?? []).flat(),
    ...before.current.plays.map((p) => p.card),
    ...before.tricks.flatMap((t) => t.plays.map((p) => p.card)),
  ].sort();
  assert.deepEqual(accounted, initialSet, '全部卡牌恰好归入 剩余+当前墩+历史墩');
  assert.equal(before.over, true);

  // 纯函数重放一致
  const hands = TWO_CARD_HANDS.map((h) => h.map(parseCard));
  const events = store.exportGame(id).events.map((e) => ({ seat: e.seat, card: parseCard(e.card) }));
  const derived = deriveState(hands, 0, 'S', events);
  assert.deepEqual(derived.wins, before.wins);
  assert.equal(derived.completed.length, 2);

  // 重启：关闭后用同一文件重新打开，局面一致
  store.close();
  store = new GameStore(db);
  const after = store.getState(id);
  assert.deepEqual(after.wins, before.wins);
  assert.equal(after.over, true);
  assert.equal(store.replay(id).consistent, true);
  store.close();
  rmSync(db, { force: true });
});

test('并发提交同一轮不同动作：只有合法的一次被接受', async () => {
  const db = tmpDb('concurrent');
  const storeA = new GameStore(db);
  const storeB = new GameStore(db);
  const id = storeA.createGame({ hands: TWO_CARD_HANDS, leader: 0, trump: 'S' });
  // 两个连接都想抢先替座位0出牌
  const [a, b] = await Promise.allSettled([
    Promise.resolve().then(() => storeA.play(id, 0, 'S2', 'cA')),
    Promise.resolve().then(() => storeB.play(id, 0, 'H10', 'cB')),
  ]);
  const states = [a, b].filter((r) => r.status === 'fulfilled');
  const rejections = [a, b].filter((r) => r.status === 'rejected');
  assert.equal(states.length, 1, '恰好一个提交成功');
  assert.equal(rejections.length, 1);
  const state = storeA.getState(id);
  assert.equal(state.current.plays.length, 1);
  assert.equal(state.turn, 1);
  storeA.close();
  storeB.close();
  rmSync(db, { force: true });
});

test('结算单元：四张出完才结算，比较逻辑正确', () => {
  const plays = [
    { seat: 0, card: parseCard('H10') },
    { seat: 1, card: parseCard('H2') },
    { seat: 2, card: parseCard('S3') },
    { seat: 3, card: parseCard('HA') },
  ];
  const trumpTrick = settleTrick(0, 0, plays, 'S');
  assert.equal(cardId(trumpTrick.winningCard), 'S3');
  assert.equal(trumpTrick.winner, 2);
  const ntTrick = settleTrick(0, 0, plays, null);
  assert.equal(cardId(ntTrick.winningCard), 'HA');
  assert.equal(ntTrick.winner, 3);
  expectCode(() => settleTrick(0, 0, plays.slice(0, 2), 'S'), 'INCOMPLETE_TRICK');
});
