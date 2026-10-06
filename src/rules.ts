export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];

export const RANK_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export type Rank = (typeof RANK_NAMES)[number];

export const RANK_VALUE: Record<Rank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14,
} as Record<Rank, number>;

export interface Card {
  suit: Suit;
  rank: Rank;
}

export interface Play {
  seat: number;
  card: Card;
}

export interface Trick {
  index: number;
  leader: number;
  plays: Play[];
  leadSuit: Suit;
  trump: Suit | null;
  winner: number;
  winningCard: Card;
  reason: string;
}

export type Trump = Suit | null;

export function cardId(card: Card): string {
  return card.suit + card.rank;
}

export function parseCard(raw: unknown): Card {
  if (typeof raw !== 'string') {
    throw new RuleError('INVALID_CARD', `卡牌编号必须是字符串，收到 ${String(raw)}`);
  }
  const suit = raw.slice(0, 1);
  const rank = raw.slice(1);
  if (!SUITS.includes(suit as Suit)) {
    throw new RuleError('UNKNOWN_SUIT', `未知花色 "${suit}"，合法花色为 S/H/D/C（无将用 NT）`);
  }
  if (!(rank in RANK_VALUE)) {
    throw new RuleError('UNKNOWN_RANK', `未知点数 "${rank}"，合法点数为 2..10,J,Q,K,A`);
  }
  return { suit: suit as Suit, rank: rank as Rank };
}

export function parseTrump(raw: unknown): Trump {
  if (raw === null || raw === undefined || raw === 'NT' || raw === 'nt') return null;
  if (typeof raw === 'string' && SUITS.includes(raw as Suit)) return raw as Suit;
  throw new RuleError('UNKNOWN_TRUMP', `将牌花色必须是 S/H/D/C 或 NT（无将），收到 ${String(raw)}`);
}

export class RuleError extends Error {
 code: string;
 constructor(code: string, message: string) {
   super(message);
   this.name = 'RuleError';
   this.code = code;
 }
}

/** 验证建局输入：固定 4 人、手牌等量、卡唯一、花色点数合法。返回规范化结构。 */
export function validateDeal(input: unknown): {
  hands: Card[][];
  leader: number;
  trump: Trump;
} {
  if (typeof input !== 'object' || input === null) {
    throw new RuleError('INVALID_BODY', '请求体必须是 JSON 对象');
  }
  const body = input as Record<string, unknown>;
  const rawHands = body.hands;
  if (!Array.isArray(rawHands)) {
    throw new RuleError('INVALID_HANDS', 'hands 必须是数组（4 个座位的手牌）');
  }
  if (rawHands.length !== 4) {
    throw new RuleError('PLAYER_COUNT', `人数必须恰好为 4，收到 ${rawHands.length}`);
  }

  const hands: Card[][] = [];
  const seen = new Set<string>();
  let expectedLen = -1;
  rawHands.forEach((seatHands, seat) => {
    if (!Array.isArray(seatHands)) {
      throw new RuleError('INVALID_HANDS', `座位 ${seat} 的手牌必须是数组`);
    }
    if (expectedLen === -1) expectedLen = seatHands.length;
    else if (seatHands.length !== expectedLen) {
      throw new RuleError('UNEQUAL_HANDS', `手牌数不等：座位 0 有 ${expectedLen} 张，座位 ${seat} 有 ${seatHands.length} 张`);
    }
    if (seatHands.length === 0) {
      throw new RuleError('INVALID_HANDS', `座位 ${seat} 手牌为空，至少需要 1 张牌`);
    }
    const parsed: Card[] = [];
    for (const rawCard of seatHands) {
      const card = parseCard(rawCard);
      const id = cardId(card);
      if (seen.has(id)) {
        throw new RuleError('DUPLICATE_CARD', `跨手牌出现重复卡牌 ${id}，每张牌必须按原始身份唯一`);
      }
      seen.add(id);
      parsed.push(card);
    }
    hands.push(parsed);
  });

  const leader = body.leader;
  if (typeof leader !== 'number' || !Number.isInteger(leader) || leader < 0 || leader > 3) {
    throw new RuleError('INVALID_LEADER', '首墩先手 leader 必须是 0..3 的整数');
  }
  const trump = parseTrump(body.trump);
  return { hands, leader, trump };
}

export interface CardLegality {
  card: string;
  legal: boolean;
  reason: string;
}

/** 判断某张候选牌当前是否可出，并给出原因。 */
export function explainCard(card: Card, hand: Card[], leadSuit: Suit | null): CardLegality {
  const id = cardId(card);
  if (leadSuit === null) {
    return { card: id, legal: true, reason: '本墩首张，可自由选择任意手牌作为引领花色' };
  }
  if (card.suit === leadSuit) {
    return { card: id, legal: true, reason: `与引领花色 ${leadSuit} 相同，跟牌合法` };
  }
  const hasLead = hand.some((c) => c.suit === leadSuit);
  if (hasLead) {
    return { card: id, legal: false, reason: `手中仍有引领花色 ${leadSuit}，必须跟同花色，不能出 ${id}` };
  }
  return { card: id, legal: true, reason: `手中已无引领花色 ${leadSuit}，可垫出任意其他花色 ${id}` };
}

/** 结算一个已凑齐 4 张的墩：有将看最大将，无将/没将看最大引领花色。 */
export function settleTrick(index: number, leader: number, plays: Play[], trump: Trump): Trick {
  if (plays.length !== 4) {
    throw new RuleError('INCOMPLETE_TRICK', `墩未满 4 张（当前 ${plays.length}），不能结算`);
  }
  const leadSuit = plays[0].card.suit;
  let winningIdx = 0;
  let winValue = -1;
  let winByTrump = false;

  plays.forEach((play, i) => {
    const isTrump = trump !== null && play.card.suit === trump;
    const isLead = play.card.suit === leadSuit;
    const value = RANK_VALUE[play.card.rank];
    if (isTrump) {
      if (!winByTrump || value > winValue) {
        winByTrump = true;
        winValue = value;
        winningIdx = i;
      }
    } else if (!winByTrump && isLead && value > winValue) {
      winValue = value;
      winningIdx = i;
    }
  });

  const winningPlay = plays[winningIdx];
  const reason = winByTrump
    ? `本墩出现将牌 ${trump}，最大将牌 ${cardId(winningPlay.card)} 获胜（异花色非将牌点数再大也不能赢）`
    : `本墩无将牌，最大引领花色 ${leadSuit} 牌 ${cardId(winningPlay.card)} 获胜`;

  return {
    index,
    leader,
    plays: plays.map((p) => ({ seat: p.seat, card: { ...p.card } })),
    leadSuit,
    trump,
    winner: winningPlay.seat,
    winningCard: { ...winningPlay.card },
    reason,
  };
}

/** 从不可变初始发牌 + 出牌事件重放出完整局面（重放本身不写库）。 */
export function deriveState(hands: Card[][], leader: number, trump: Trump, events: Play[]): {
  remaining: Card[][];
  completed: Trick[];
  current: { leader: number; plays: Play[]; leadSuit: Suit | null };
  turn: number;
  wins: number[];
  over: boolean;
  totalTricks: number;
} {
  const remaining: Card[][] = hands.map((h) => h.map((c) => ({ ...c })));
  const completed: Trick[] = [];
  const wins = [0, 0, 0, 0];
  let currentLeader = leader;
  let currentPlays: Play[] = [];
  const totalTricks = hands[0].length;

  for (const ev of events) {
    const seatHand = remaining[ev.seat];
    const idx = seatHand.findIndex((c) => c.suit === ev.card.suit && c.rank === ev.card.rank);
    if (idx === -1) {
      throw new RuleError('REPLAY_MISMATCH', `重放失败：座位 ${ev.seat} 手中没有 ${cardId(ev.card)}`);
    }
    const expectedSeat = (currentLeader + currentPlays.length) % 4;
    if (ev.seat !== expectedSeat) {
      throw new RuleError('REPLAY_MISMATCH', `重放失败：应由座位 ${expectedSeat} 出牌，却记录座位 ${ev.seat}`);
    }
    const leadSuit = currentPlays.length === 0 ? null : currentPlays[0].card.suit;
    const legality = explainCard(ev.card, seatHand, leadSuit);
    if (!legality.legal) {
      throw new RuleError('REPLAY_MISMATCH', `重放失败：${legality.reason}`);
    }
    seatHand.splice(idx, 1);
    currentPlays.push({ seat: ev.seat, card: { ...ev.card } });
    if (currentPlays.length === 4) {
      const trick = settleTrick(completed.length, currentLeader, currentPlays, trump);
      completed.push(trick);
      wins[trick.winner] += 1;
      currentLeader = trick.winner;
      currentPlays = [];
    }
  }

  const over = completed.length === totalTricks;
  const turn = over ? -1 : (currentLeader + currentPlays.length) % 4;
  return {
    remaining,
    completed,
    current: {
      leader: currentLeader,
      plays: currentPlays,
      leadSuit: currentPlays.length === 0 ? null : currentPlays[0].card.suit,
    },
    turn,
    wins,
    over,
    totalTricks,
  };
}
