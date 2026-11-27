/**
 * side-packet-lab — 三包、两块屏幕、一屏公共。
 *
 * Wire layout (all numbers int32, little-endian):
 *
 *   header (4)   magic | version | kind | flags
 *   room tag (4) uint32, constant for the room
 *   record × 2   uint16 name byte-length | name UTF-8 | int32 score
 *   secret × N   int32 each
 *
 * With names 甲 (3 UTF-8 bytes) and 乙 (3 UTF-8 bytes):
 *
 *   public   = 8 + (2+3+4) + (2+3+4)       = 26 bytes   (no secret slot)
 *   private  = 26 + 4                       = 30 bytes   (one secret slot)
 *   leak     = 26 + 4 + 4                   = 34 bytes   (two secret slots)
 *
 * The secret slot is physically absent from a public frame — not blanked, not
 * present-but-zero. 41 and 17 cannot appear in the public packet because the
 * bytes that would carry them do not exist.
 *
 * Names are counted in UTF-8 bytes. 甲 and 乙 are three bytes each; swapping in
 * any other name changes the totals, so 26 / 30 stop matching on purpose.
 *
 * Scores and secrets are integers. Nothing is rounded, no unit is folded:
 * 41 stays 41 and 17 stays 17, and a 40 or 16 is rejected.
 */

export const MAGIC = 0x53;
export const VERSION = 1;

export const KIND = {
  PUBLIC: 0,
  PRIVATE: 1,
  LEAK: 2,
} as const;
export type FrameKind = (typeof KIND)[keyof typeof KIND];

export const HEADER_BYTES = 4;
export const ROOM_TAG_BYTES = 4;
export const NAME_LENGTH_BYTES = 2;
export const SCORE_BYTES = 4;
export const SECRET_BYTES = 4;
export const RECORD_COUNT = 2;

export const CANONICAL_NAMES = ['甲', '乙'] as const;
export const CANONICAL_SCORES = [8, 12] as const;
export const CANONICAL_SECRETS = [41, 17] as const;

export const PUBLIC_RECIPIENT = 'public';

/** Owner index carried in the flags byte of a private frame. */
export const OWNER_INDEX = {
  '甲': 0,
  '乙': 1,
} as const;

export type OwnerName = keyof typeof OWNER_INDEX;

export function ownerForIndex(index: number): OwnerName | undefined {
  if (index === 0) { return '甲'; }
  if (index === 1) { return '乙'; }
  return undefined;
}

export function indexForOwner(owner: string): number | undefined {
  return owner === '甲' ? 0 : owner === '乙' ? 1 : undefined;
}

const textEncoder = new TextEncoder();

export function utf8Length(value: string): number {
  return textEncoder.encode(value).length;
}

/** Public frame size for a list of player names. */
export function expectedPublicLength(names: readonly string[]): number {
  let length = HEADER_BYTES + ROOM_TAG_BYTES;
  for (const name of names) {
    length += NAME_LENGTH_BYTES + utf8Length(name) + SCORE_BYTES;
  }
  return length;
}

export function expectedPrivateLength(names: readonly string[]): number {
  return expectedPublicLength(names) + SECRET_BYTES;
}

export function expectedLeakLength(names: readonly string[]): number {
  return expectedPublicLength(names) + 2 * SECRET_BYTES;
}

/** The three measured sizes, for 甲 / 乙. */
export const CANONICAL_PUBLIC_LENGTH = expectedPublicLength(CANONICAL_NAMES);   // 26
export const CANONICAL_PRIVATE_LENGTH = expectedPrivateLength(CANONICAL_NAMES); // 30
export const CANONICAL_LEAK_LENGTH = expectedLeakLength(CANONICAL_NAMES);       // 34

/** Every rejection reason maps to one of these codes. */
export const REJECT = {
  BAD_MAGIC: 'BAD_MAGIC',
  BAD_VERSION: 'BAD_VERSION',
  BAD_LENGTH: 'BAD_LENGTH',
  BAD_NAME: 'BAD_NAME',
  BAD_FLAGS: 'BAD_FLAGS',
  BAD_CONFIG: 'BAD_CONFIG',

  PUBLIC_LENGTH: 'PUBLIC_LENGTH',
  PUBLIC_HAS_SECRET: 'PUBLIC_HAS_SECRET',
  PUBLIC_NOT_PUBLIC: 'PUBLIC_NOT_PUBLIC',

  PRIVATE_LENGTH: 'PRIVATE_LENGTH',
  PRIVATE_HAS_NO_SECRET: 'PRIVATE_HAS_NO_SECRET',
  WRONG_OWNER: 'WRONG_OWNER',
  WRONG_SECRET: 'WRONG_SECRET',
  SWAPPED_SECRET: 'SWAPPED_SECRET',
  OTHER_SECRET_VISIBLE: 'OTHER_SECRET_VISIBLE',

  LEAK_DETECTED: 'LEAK_DETECTED',
  BOTH_SECRETS_IN_ONE: 'BOTH_SECRETS_IN_ONE',

  WRONG_SCORE: 'WRONG_SCORE',
  NON_INTEGER: 'NON_INTEGER',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  ROUNDED_VALUE: 'ROUNDED_VALUE',

  MISSING_PACKET: 'MISSING_PACKET',
  DUPLICATE_PACKET: 'DUPLICATE_PACKET',
  INCOMPLETE_BUNDLE: 'INCOMPLETE_BUNDLE',
  THIRD_PERSON: 'THIRD_PERSON',

  SCREEN_PACKET_MISMATCH: 'SCREEN_PACKET_MISMATCH',
  PUBLIC_SCREEN_HAS_SECRET: 'PUBLIC_SCREEN_HAS_SECRET',
  WRONG_LAYOUT: 'WRONG_LAYOUT',
  AMBIGUOUS_INSPECTION: 'AMBIGUOUS_INSPECTION',
  STALE_PACKET: 'STALE_PACKET',
} as const;

export type RejectCode = (typeof REJECT)[keyof typeof REJECT];

export class PacketRejected extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'PacketRejected';
    this.code = code;
  }
}

/** Throw a rejection. Declared `never` so callers narrow after using it. */
export function reject(code: string, message: string): never {
  throw new PacketRejected(code, message);
}

export function isPacketRejected(error: unknown): error is PacketRejected {
  return error instanceof PacketRejected;
}
