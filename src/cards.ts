import {
  RANKS,
  SUITS,
  type Card,
  type CardId,
  type Rank,
  type Seat,
  type Suit,
} from './types.js';
import { ErrorCodes, RuleError } from './errors.js';

const rankIndex = new Map<Rank, number>(RANKS.map((r, i) => [r, i]));
const suitSet = new Set<Suit>(SUITS);

export function rankValue(rank: Rank): number {
  return rankIndex.get(rank)!;
}

export function isSuit(s: string): s is Suit {
  return suitSet.has(s as Suit);
}

export function isRank(r: string): r is Rank {
  return rankIndex.has(r as Rank);
}

// 解析 "H10" -> { suit: 'H', rank: '10' }；非法则抛 UNKNOWN_SUIT_RANK
export function parseCard(id: string): Card {
  if (typeof id !== 'string' || id.length < 2) {
    throw new RuleError(
      ErrorCodes.UNKNOWN_SUIT_RANK,
      `未知卡牌编号：${String(id)}（应为花色 S/H/D/C 加点数 2..10/J/Q/K/A，例如 H10）`,
      { card: id },
    );
  }
  const suit = id[0]!;
  const rank = id.slice(1);
  if (!isSuit(suit) || !isRank(rank)) {
    throw new RuleError(
      ErrorCodes.UNKNOWN_SUIT_RANK,
      `未知花色或点数：${id}`,
      { card: id },
    );
  }
  return { suit, rank };
}

export function cardId(card: Card): CardId {
  return `${card.suit}${card.rank}`;
}

export function seatLabel(seat: Seat): string {
  return `座位${seat}`;
}
