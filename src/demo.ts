import { GameStore } from './store.js';

const HANDS: string[][] = [
  ['H10', 'H3', 'S2', 'D2', 'C2'],
  ['H2', 'H4', 'S4', 'D3', 'C3'],
  ['S3', 'S5', 'S6', 'D4', 'C4'],
  ['HA', 'HK', 'D5', 'D6', 'D7'],
];

const FIRST_TRICK = [
  { seat: 0, card: 'H10' },
  { seat: 1, card: 'H2' },
  { seat: 2, card: 'S3' },
  { seat: 3, card: 'HA' },
] as const;

function hr(title: string): void {
  console.log('\n' + '='.repeat(64));
  console.log(title);
  console.log('='.repeat(64));
}

export async function runDemo(store: GameStore): Promise<void> {
  console.log('固定缩小牌组（每人 5 张，共 20 张，身份唯一）:');
  HANDS.forEach((h, seat) => console.log(`  座位 ${seat}: ${h.join(' ')}`));

  // ---------- 场景 1：黑桃为将 ----------
  hr('场景 1：黑桃 S 为将，首墩先手座位 0');
  const trumpGame = store.createGame({ hands: HANDS, leader: 0, trump: 'S' });
  console.log(`已建局，局号 = ${trumpGame}`);

  let seq = 0;
  store.play(trumpGame, FIRST_TRICK[0].seat, FIRST_TRICK[0].card, `demo-S-${seq}`);
  seq++;
  // 拒绝案例：座位1 手中有红桃，却想在红桃领出后出黑桃 S4
  try {
    store.play(trumpGame, 1, 'S4', 'demo-illegal-s4');
  } catch (err) {
    console.log(`拒绝案例：座位1 有红桃却出 S4 -> [${(err as { code: string }).code}] ${(err as Error).message}`);
  }
  for (const move of FIRST_TRICK.slice(1)) {
    const result = store.play(trumpGame, move.seat, move.card, `demo-S-${seq++}`);
    void result;
  }
  let state = store.getState(trumpGame);
  const trick = state.tricks[0];
  console.log('四张出牌顺序: ' + trick.plays.map((p) => `座位${p.seat}:${p.card}`).join(' -> '));
  console.log(`判定: ${trick.reason}`);
  console.log(`赢家: 座位 ${trick.winner}（正确应为座位 2，S3 将吃）`);
  console.log(`下一墩先手: 座位 ${state.current.leader}`);
  console.log('剩余手牌:');
  state.remaining!.forEach((h, seat) => console.log(`  座位 ${seat}: ${h.join(' ')}（${h.length} 张）`));

  // 重试幂等：用同一 requestId 再出一次，不重复消耗
  const retry = store.play(trumpGame, 0, 'H10', 'demo-S-0');
  console.log(`同 requestId 重试首牌 -> idempotent=${retry.idempotent}，事件数不增加，牌不重复消耗`);
  try {
    store.play(trumpGame, 0, 'H3', 'demo-S-0');
  } catch (err) {
    console.log(`同 requestId 不同内容 -> [${(err as { code: string }).code}]`);
  }

  // ---------- 场景 2：无将 ----------
  hr('场景 2：无将 NT，首墩先手座位 0');
  const ntGame = store.createGame({ hands: HANDS, leader: 0, trump: 'NT' });
  console.log(`已建局，局号 = ${ntGame}（与场景1互相隔离，各自独立）`);
  seq = 0;
  for (const move of FIRST_TRICK) {
    store.play(ntGame, move.seat, move.card, `demo-NT-${seq++}`);
  }
  state = store.getState(ntGame);
  console.log(`判定: ${state.tricks[0].reason}`);
  console.log(`赢家: 座位 ${state.tricks[0].winner}（正确应为座位 3，HA 最大引领花色牌）`);

  hr('回放核验与导出');
  console.log('将牌局回放:', JSON.stringify(store.replay(trumpGame)));
  const exported = store.exportGame(trumpGame);
  console.log(`导出: ${exported.events.length} 条出牌事件，初始手牌不可变，规则 trump=${exported.rules.trump}`);
}
