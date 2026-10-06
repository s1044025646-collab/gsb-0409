// 座位编号：0=北 1=东 2=南 3=西，固定顺序循环出牌
export type Seat = 0 | 1 | 2 | 3;

export type Suit = 'S' | 'H' | 'D' | 'C';
// S=黑桃(Spades) H=红桃(Hearts) D=方块(Diamonds) C=梅花(Clubs)

export const SEATS: ReadonlyArray<Seat> = [0, 1, 2, 3];

export const SEAT_NAMES = ['北', '东', '南', '西'] as const;

export const SUITS: ReadonlyArray<Suit> = ['S', 'H', 'D', 'C'];

export const SUIT_NAMES: Record<Suit, string> = {
  S: '黑桃',
  H: '红桃',
  D: '方块',
  C: '梅花',
};

// 2 最小，A 最大
export const RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
] as const;

export type Rank = (typeof RANKS)[number];

// 卡牌原始身份：花色 + 点数。每张牌在整局中唯一，不做合并。
export interface Card {
  suit: Suit;
  rank: Rank;
}

// 卡牌编号即规范字符串，例如 "H10"、"SA"
export type CardId = string;

// 将牌花色；null 表示无将（NT）
export type Trump = Suit | null;

export interface CreateGameInput {
  gameId?: string;
  hands: [CardId[], CardId[], CardId[], CardId[]];
  firstLeader: Seat;
  trump: Trump;
}

export interface PlayedCard {
  seat: Seat;
  card: CardId;
  // 该牌在本墩中的序号（0..3）
  order: number;
}

export interface TrickResult {
  trickNo: number;
  plays: PlayedCard[];
  leadSuit: Suit;
  trump: Trump;
  winner: Seat;
  // 判定比较说明
  comparison: string[];
  winningCard: CardId;
}

export interface GameState {
  gameId: string;
  hands: [CardId[], CardId[], CardId[], CardId[]];
  trump: Trump;
  firstLeader: Seat;
  currentTrickNo: number; // 从 1 开始
  currentLeader: Seat;
  currentTrick: PlayedCard[];
  completedTricks: TrickResult[];
  finished: boolean;
  tricksPerPlayer: number;
}

export interface LegalOption {
  card: CardId;
  legal: boolean;
  reason: string;
}

export interface ApiError {
  error: string;
  message: string;
}
