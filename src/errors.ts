// 明确的错误码，API 与 CLI 共用
export const ErrorCodes = {
  INVALID_JSON: 'INVALID_JSON',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_SUIT_RANK: 'UNKNOWN_SUIT_RANK',
  DUPLICATE_CARD: 'DUPLICATE_CARD',
  HAND_COUNT_MISMATCH: 'HAND_COUNT_MISMATCH',
  PLAYER_COUNT_ERROR: 'PLAYER_COUNT_ERROR',
  EMPTY_HANDS: 'EMPTY_HANDS',
  GAME_NOT_FOUND: 'GAME_NOT_FOUND',
  GAME_ALREADY_EXISTS: 'GAME_ALREADY_EXISTS',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  CARD_NOT_IN_HAND: 'CARD_NOT_IN_HAND',
  MUST_FOLLOW_SUIT: 'MUST_FOLLOW_SUIT',
  GAME_FINISHED: 'GAME_FINISHED',
  REQUEST_CONFLICT: 'REQUEST_CONFLICT',
  REPLAY_MISMATCH: 'REPLAY_MISMATCH',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class RuleError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
    this.details = details;
  }
}

// 各错误码对应的 HTTP 状态
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'GAME_NOT_FOUND':
      return 404;
    case 'GAME_ALREADY_EXISTS':
    case 'REQUEST_CONFLICT':
    case 'REPLAY_MISMATCH':
      return 409;
    case 'INVALID_JSON':
      return 400;
    case 'INTERNAL_ERROR':
      return 500;
    default:
      // 所有规则/校验类错误
      return 422;
  }
}
