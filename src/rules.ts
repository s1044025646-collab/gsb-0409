import { parseCard, rankValue } from './cards.js';
import { ErrorCodes, RuleError } from './errors.js';
import {
  SEATS,
  SUITS,
  type CardId,
  type CreateGameInput,
  type GameState,
  type LegalOption,
  type PlayedCard,
  type Seat,
  type Suit,
  type TrickResult,
  type Trump,
} from './types.js';

export function isSeat(n: unknown): n is Seat {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 3;
}

export function normalizeTrump(t: unknown): Trump {
  if (t === null || t === 'NT' || t === undefined) {
    return t === undefined ? null : (t as Trump);
  }
  if (typeof t !== 'string' || !SUITS.includes(t as Suit)) {
    throw new RuleError(
      ErrorCodes.VALIDATION_ERROR,
      `将牌花色必须是 S/H/D/C 或 NT/ null（无将），收到：${String(t)}`,
    );
  }
  return t as Suit;
}

export interface ValidatedDeal {
  hands: [CardId[], CardId[], CardId[], CardId[]];
  firstLeader: Seat;
  trump: Trump;
}

// 建局校验：人数、手牌非空且数量相等、卡牌身份合法、全局无重复
export function validateDeal(input: unknown): ValidatedDeal {
  if (typeof input !== 'object' || input === null) {
    throw new RuleError(ErrorCodes.VALIDATION_ERROR, '请求体必须是对象');
  }
  const body = input as Record<string, unknown>;
  const hands = body.hands;
  if (!Array.isArray(hands)) {
    throw new RuleError(
      ErrorCodes.PLAYER_COUNT_ERROR,
      '必须提供 hands，且为四个座位的手牌数组',
    );
  }
  if (hands.length !== 4) {
    throw new RuleError(
      ErrorCodes.PLAYER_COUNT_ERROR,
      `固定四人游戏，hands 长度必须为 4，收到 ${hands.length}`,
    );
  }

  const normalized: [CardId[], CardId[], CardId[], CardId[]] = [[], [], [], []];
  const seen = new Set<CardId>();
  let expectedCount: number | null = null;

  for (const seat of SEATS) {
    const hand = hands[seat];
    if (!Array.isArray(hand)) {
      throw new RuleError(
        ErrorCodes.PLAYER_COUNT_ERROR,
        `座位 ${seat} 的手牌必须是数组`,
      );
    }
    if (hand.length === 0) {
      throw new RuleError(
        ErrorCodes.EMPTY_HANDS,
        `座位 ${seat} 的手牌为空：每人手牌数须相等且至少一张`,
      );
    }
    if (expectedCount === null) {
      expectedCount = hand.length;
    } else if (hand.length !== expectedCount) {
      throw new RuleError(
        ErrorCodes.HAND_COUNT_MISMATCH,
        `手牌数不等：座位 0 有 ${expectedCount} 张，座位 ${seat} 有 ${hand.length} 张`,
        { expected: expectedCount, actual: hand.length, seat },
      );
    }

    for (const raw of hand) {
      if (typeof raw !== 'string') {
        throw new RuleError(
          ErrorCodes.UNKNOWN_SUIT_RANK,
          `座位 ${seat} 的手牌中存在非字符串卡牌：${String(raw)}`,
        );
      }
      // 解析即校验花色点数；抛 UNKNOWN_SUIT_RANK
      parseCard(raw);
      const id = raw;
      if (seen.has(id)) {
        throw new RuleError(
          ErrorCodes.DUPLICATE_CARD,
          `卡牌 ${id} 在初始手牌中重复：每张牌身份必须唯一，禁止跨手牌重复`,
          { card: id },
        );
      }
      seen.add(id);
      normalized[seat].push(id);
    }
  }

  if (!isSeat(body.firstLeader)) {
    throw new RuleError(
      ErrorCodes.VALIDATION_ERROR,
      'firstLeader 必须是 0/1/2/3 的座位编号',
    );
  }
  const trump =
    Object.prototype.hasOwnProperty.call(body, 'trump') ||
    Object.prototype.hasOwnProperty.call(input as object, 'trump')
      ? normalizeTrump(body.trump)
      : null;

  return {
    hands: normalized,
    firstLeader: body.firstLeader,
    trump,
  };
}

export function expectedTurn(state: GameState): Seat {
  const offset = state.currentTrick.length;
  return ((state.currentLeader + offset) % 4) as Seat;
}

// 该玩家视角下每张候选牌的可出性与理由
export function legalOptions(state: GameState, seat: Seat): LegalOption[] {
  return state.hands[seat].map((card) => {
    const decision = evaluatePlay(state, seat, card, { dryRun: true });
    return { card, legal: decision.ok, reason: decision.reason };
  });
}

interface PlayDecision {
  ok: boolean;
  reason: string;
}

export function evaluatePlay(
  state: GameState,
  seat: Seat,
  card: CardId,
  opts: { dryRun?: boolean } = {},
): PlayDecision {
  if (state.finished) {
    throw new RuleError(
      ErrorCodes.GAME_FINISHED,
      `对局已结束，共 ${state.completedTricks.length} 墩`,
    );
  }
  if (!state.hands[seat].includes(card)) {
    // 非法卡牌编号先给更明确的花色点数错误
    parseCard(card);
    throw new RuleError(
      ErrorCodes.CARD_NOT_IN_HAND,
      `卡牌 ${card} 不在座位 ${seat} 的手牌中（可能已打出）`,
      { card, seat },
    );
  }

  const turn = expectedTurn(state);
  if (seat !== turn) {
    throw new RuleError(
      ErrorCodes.NOT_YOUR_TURN,
      `还没轮到座位 ${seat}：当前应由座位 ${turn} 出牌`,
      { expected: turn, actual: seat },
    );
  }

  // 第一张牌：引领花色，任意手牌都合法
  if (state.currentTrick.length === 0) {
    return {
      ok: true,
      reason: `本墩由座位 ${seat} 先手领出，可选择任意手牌；${card} 将决定引领花色`,
    };
  }

  const leadSuit = parseCard(state.currentTrick[0]!.card).suit;
  const played = parseCard(card);
  const hasLead = state.hands[seat].some(
    (c) => parseCard(c).suit === leadSuit,
  );

  if (played.suit === leadSuit) {
    return { ok: true, reason: `跟随引领花色${leadSuit}，出牌合法` };
  }
  if (hasLead) {
    const reason = `必须跟随引领花色 ${leadSuit}：座位 ${seat} 手中仍有该花色牌，不能出 ${card}`;
    if (!opts.dryRun) {
      throw new RuleError(ErrorCodes.MUST_FOLLOW_SUIT, reason, {
        leadSuit,
        card,
      });
    }
    return { ok: false, reason };
  }
  if (state.trump !== null && played.suit === state.trump) {
    return {
      ok: true,
      reason: `手中已无引领花色 ${leadSuit}，可出将牌${state.trump}吃墩`,
    };
  }
  return {
    ok: true,
    reason: `手中已无引领花色 ${leadSuit}，可垫出任意其他花色（${played.suit}），该牌不直接赢墩`,
  };
}

// 结算四张牌：有将牌则最大将牌赢，否则最大引领花色牌赢
export function settleTrick(
  trickNo: number,
  plays: PlayedCard[],
  trump: Trump,
): TrickResult {
  if (plays.length !== 4) {
    throw new RuleError(
      ErrorCodes.INTERNAL_ERROR,
      `墩 ${trickNo} 未满四张（${plays.length} 张），不能结算`,
    );
  }
  const leadSuit = parseCard(plays[0]!.card).suit;
  const comparison: string[] = [
    `引领花色为 ${leadSuit}，将牌为 ${trump ?? '无将(NT)'}`,
  ];

  const trumps = plays.filter((p) => parseCard(p.card).suit === trump);
  let winner: PlayedCard;
  if (trumps.length > 0) {
    winner = trumps.reduce((best, p) =>
      rankValue(parseCard(p.card).rank) > rankValue(parseCard(best.card).rank)
        ? p
        : best,
    );
    comparison.push(
      `本墩出现 ${trumps.length} 张将牌：${trumps.map((t) => t.card).join('、')}，按点数比较`,
    );
    comparison.push(
      `最大将牌为 ${winner.card}（座位 ${winner.seat}），赢得本墩；异花色非将牌不参与赢墩`,
    );
  } else {
    const following = plays.filter(
      (p) => parseCard(p.card).suit === leadSuit,
    );
    winner = following.reduce((best, p) =>
      rankValue(parseCard(p.card).rank) > rankValue(parseCard(best.card).rank)
        ? p
        : best,
    );
    comparison.push(
      `本墩无将牌，仅比较引领花色 ${leadSuit}：${following
        .map((t) => t.card)
        .join('、')}`,
    );
    comparison.push(
      `最大引领花色牌为 ${winner.card}（座位 ${winner.seat}），赢得本墩；垫出的异花色牌即使点数更大也不能获胜`,
    );
  }

  return {
    trickNo,
    plays: plays.map((p) => ({ ...p })),
    leadSuit,
    trump,
    winner: winner.seat,
    comparison,
    winningCard: winner.card,
  };
}

// 纯函数：在状态上应用一次合法出牌（调用方已做全部校验）
export function applyPlay(
  state: GameState,
  seat: Seat,
  card: CardId,
): { state: GameState; settled: TrickResult | null } {
  const hands = state.hands.map((h) => h.slice()) as [
    CardId[],
    CardId[],
    CardId[],
    CardId[],
  ];
  const idx = hands[seat].indexOf(card);
  hands[seat].splice(idx, 1);

  const currentTrick = state.currentTrick.slice();
  currentTrick.push({ seat, card, order: currentTrick.length });

  let completedTricks = state.completedTricks;
  let currentLeader = state.currentLeader;
  let currentTrickNo = state.currentTrickNo;
  let finished = state.finished;
  let settled: TrickResult | null = null;
  let nextTrick: PlayedCard[] = currentTrick;

  if (currentTrick.length === 4) {
    settled = settleTrick(currentTrickNo, currentTrick, state.trump);
    completedTricks = completedTricks.concat(settled);
    currentLeader = settled.winner;
    nextTrick = [];
    currentTrickNo += 1;
    if (hands[0].length === 0) {
      finished = true;
    }
  }

  return {
    settled,
    state: {
      ...state,
      hands,
      currentTrick: nextTrick,
      completedTricks,
      currentLeader,
      currentTrickNo,
      finished,
    },
  };
}

export function trickCounts(
  state: GameState,
): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const trick of state.completedTricks) {
    counts[trick.winner] += 1;
  }
  return counts;
}

// 由初始发牌 + 出牌事件序列重建状态（回放核心）
export function replay(
  deal: ValidatedDeal,
  gameId: string,
  plays: ReadonlyArray<{ seat: Seat; card: CardId }>,
): GameState {
  const cardsPerPlayer = deal.hands[0].length;
  let state: GameState = {
    gameId,
    hands: deal.hands.map((h) => h.slice()) as [
      CardId[],
      CardId[],
      CardId[],
      CardId[],
    ],
    trump: deal.trump,
    firstLeader: deal.firstLeader,
    currentTrickNo: 1,
    currentLeader: deal.firstLeader,
    currentTrick: [],
    completedTricks: [],
    finished: false,
    tricksPerPlayer: cardsPerPlayer,
  };

  for (const event of plays) {
    // 逐张走同一套校验，任何不一致都会抛错
    evaluatePlay(state, event.seat, event.card);
    state = applyPlay(state, event.seat, event.card).state;
  }
  return state;
}

export function freshState(
  gameId: string,
  deal: ValidatedDeal,
): GameState {
  return replay(deal, gameId, []);
}
