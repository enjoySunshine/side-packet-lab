/**
 * Semantic validation: the rules a recipient applies to a packet before it is
 * allowed to reach a screen.
 *
 * The decoder answers "is this a well-formed byte string of the declared
 * kind". This module answers "is this the packet this room should ever have
 * produced" — canonical names, canonical scores, integer secrets, no crossed
 * secret.
 */

import {
  CANONICAL_NAMES,
  CANONICAL_SCORES,
  CANONICAL_SECRETS,
  PUBLIC_RECIPIENT,
  REJECT,
  reject,
  type OwnerName,
} from './protocol.ts';
import type { ParsedFrame, PlayerRecord } from './codec.ts';

export interface RoomConfig {
  players: readonly [string, string];
  scores: readonly [number, number];
  secrets: readonly [number, number];
}

export const CANONICAL_ROOM: RoomConfig = {
  players: CANONICAL_NAMES,
  scores: CANONICAL_SCORES,
  secrets: CANONICAL_SECRETS,
};

export type Recipient = string; // 'public' | '甲' | '乙'

/**
 * 26 / 30 only hold for 甲 and 乙. A different name changes the byte total, so
 * the length check and the name check are the same check.
 */
export function assertCanonicalNames(config: RoomConfig): void {
  if (config.players[0] !== CANONICAL_NAMES[0] || config.players[1] !== CANONICAL_NAMES[1]) {
    reject(
      REJECT.BAD_NAME,
      `按甲和乙量出来的是 26 / 30；换成 ${config.players.join(' / ')} 包长就对不上了`,
    );
  }
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    reject(REJECT.NON_INTEGER, `${label} 必须是整数，收到 ${value}`);
  }
}

/**
 * 41 must stay 41 and 17 must stay 17. A 40 or a 16 is a rounded / folded
 * value and is rejected. The two secrets must also differ: if both packets
 * carried the same number, "两包长度一样" would stop distinguishing 甲 from 乙.
 */
export function assertSecretsAreDistinctIntegers(config: RoomConfig): void {
  assertInteger(config.secrets[0], `${config.players[0]} 的暗格`);
  assertInteger(config.secrets[1], `${config.players[1]} 的暗格`);
  if (config.secrets[0] === config.secrets[1]) {
    reject(
      REJECT.BOTH_SECRETS_IN_ONE,
      `甲和乙的暗格都是 ${config.secrets[0]}；两包只靠长度分不出主人`,
    );
  }
}

export function validateConfig(config: RoomConfig): void {
  assertCanonicalNames(config);
  assertInteger(config.scores[0], `${config.players[0]} 的分数`);
  assertInteger(config.scores[1], `${config.players[1]} 的分数`);
  assertSecretsAreDistinctIntegers(config);
}

function playerIndex(config: RoomConfig, name: string): number {
  return config.players.indexOf(name);
}

function otherOwner(config: RoomConfig, owner: OwnerName): OwnerName {
  const ownIndex = playerIndex(config, owner);
  return config.players[1 - ownIndex] as OwnerName;
}

/** The canonical (name, score) pair for each player, in packet order. */
export function expectedRecords(config: RoomConfig): PlayerRecord[] {
  return config.players.map((name, index) => ({
    name,
    score: config.scores[index],
  }));
}

function assertScores(config: RoomConfig, frame: ParsedFrame, recipient: string): void {
  const expected = expectedRecords(config);
  if (frame.records.length !== expected.length) {
    reject(REJECT.WRONG_SCORE, `${recipient} 的包里有 ${frame.records.length} 个分数，应为 ${expected.length} 个`);
  }
  for (let i = 0; i < expected.length; i++) {
    const got = frame.records[i];
    if (got.name !== expected[i].name) {
      reject(REJECT.BAD_NAME, `${recipient} 的包里第 ${i + 1} 个名字是 ${got.name}，应为 ${expected[i].name}`);
    }
    if (got.score !== expected[i].score) {
      reject(REJECT.WRONG_SCORE, `${recipient} 的包里 ${got.name} 的分数是 ${got.score}，应为 ${expected[i].score}`);
    }
  }
}

/**
 * Validate a packet for a given recipient.
 *
 * `recipient` is `'public'` for the shared screen, or a player name. Returns the
 * validated frame; throws {@link PacketRejected} on every violation.
 */
export function validateForRecipient(
  config: RoomConfig,
  frame: ParsedFrame,
  recipient: Recipient,
): ParsedFrame {
  validateConfig(config);

  if (recipient !== PUBLIC_RECIPIENT && playerIndex(config, recipient) === -1) {
    reject(REJECT.THIRD_PERSON, `房间里没有第三个人：${recipient}`);
  }

  // Two secrets in one packet is always wrong, whoever it was meant for.
  if (frame.kind === 'leak' || frame.secrets.length > 1) {
    reject(
      REJECT.BOTH_SECRETS_IN_ONE,
      `这一包同时带着 ${frame.secrets.join(' 和 ')}；34 字节，比 30 多出来的就是不该给这个人的那一格`,
    );
  }

  if (recipient === PUBLIC_RECIPIENT) {
    if (frame.kind !== 'public') {
      reject(
        REJECT.PUBLIC_NOT_PUBLIC,
        `公共屏幕的包必须是 26 字节的公共帧；收到 ${frame.kind === 'private' ? '带暗格的 30 字节私有帧' : '泄漏帧'}`,
      );
    }
    assertScores(config, frame, '公共屏');
    return frame;
  }

  if (frame.kind === 'public') {
    reject(REJECT.PRIVATE_HAS_NO_SECRET, `${recipient} 的包是 26 字节的公共帧，里面没有暗格`);
  }
  if (frame.kind !== 'private') {
    reject(REJECT.LEAK_DETECTED, `${recipient} 的包不是 30 字节的私有帧`);
  }

  const owner = recipient as OwnerName;
  if (frame.owner !== owner) {
    reject(REJECT.WRONG_OWNER, `这一包的主人是 ${frame.owner}，不是 ${recipient}`);
  }
  assertScores(config, frame, recipient);

  const ownSecret = config.secrets[playerIndex(config, owner)];
  const otherSecret = config.secrets[playerIndex(config, otherOwner(config, owner))];

  if (frame.secrets.length !== 1) {
    reject(REJECT.OTHER_SECRET_VISIBLE, `${recipient} 的包里带着 ${frame.secrets.length} 个暗格`);
  }
  const carried = frame.secrets[0];
  if (carried === ownSecret) {
    return frame;
  }
  if (carried === otherSecret) {
    reject(REJECT.SWAPPED_SECRET, `${recipient} 的包里是 ${otherSecret}，那是另一个人的暗格；应为 ${ownSecret}`);
  }
  reject(REJECT.WRONG_SECRET, `${recipient} 的暗格是 ${carried}，应为 ${ownSecret}`);
}

/** True iff the frame may reach the given recipient's screen. */
export function isAcceptable(config: RoomConfig, frame: ParsedFrame, recipient: Recipient): boolean {
  try {
    validateForRecipient(config, frame, recipient);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) { return false; }
    throw error;
  }
}
