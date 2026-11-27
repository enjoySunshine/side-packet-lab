/**
 * Screens are drawn *from packets*, never from a parallel mutable state.
 *
 * This is the property the lab spends most of its words on: if a screen and
 * the packet feeding it can disagree, then "只改甲的屏幕" or "只改乙的屏幕"
 * would be observable. Projecting the screen out of the decoded packet makes
 * that class of bug unrepresentable — and the assertions below catch a
 * hand-built screen that tries to sneak past.
 */

import {
  CANONICAL_PUBLIC_LENGTH,
  REJECT,
  reject,
  type OwnerName,
} from './protocol.ts';
import type { ParsedFrame } from './codec.ts';
import type { RoomConfig } from './validate.ts';

export interface ScreenCell {
  name: string;
  score: number;
  /** `null` means the cell is drawn empty — nothing to show for this player. */
  secret: number | null;
}

export interface PublicScreen {
  position: 'top';
  packetLength: number;
  cells: ScreenCell[];
  secrets: [];
}

export interface PlayerScreen {
  position: 'left' | 'right';
  owner: OwnerName;
  packetLength: number;
  own: { name: string; score: number; secret: number };
  other: { name: string; score: number; secret: null };
}

export type Screen = PublicScreen | PlayerScreen;

export interface Screens {
  public: PublicScreen;
  byOwner: Record<OwnerName, PlayerScreen>;
  layout: { top: PublicScreen; left: PlayerScreen; right: PlayerScreen };
}

/** Where 甲 and 乙 hang in the preview. */
export function screenPositionFor(owner: OwnerName): 'left' | 'right' {
  return owner === '甲' ? 'left' : 'right';
}

/**
 * Project a packet into the screen its recipient sees.
 *
 * The public packet yields two score cells and no secret cells at all.
 * A private packet yields a screen where the owner's cell carries the secret
 * and the other player's secret cell is drawn empty — the other number is
 * not on this screen, not even blanked out, because it never entered the
 * packet the screen was drawn from.
 */
export function drawScreenFromPacket(frame: ParsedFrame, packetLength: number): Screen {
  if (frame.kind === 'public') {
    return {
      position: 'top',
      packetLength,
      cells: frame.records.map((record) => ({ name: record.name, score: record.score, secret: null })),
      secrets: [],
    };
  }

  if (frame.kind === 'private') {
    const ownRecord = frame.records.find((record) => record.name === frame.owner);
    const otherRecord = frame.records.find((record) => record.name !== frame.owner);
    if (ownRecord === undefined || otherRecord === undefined) {
      reject(REJECT.BAD_NAME, `私有包里找不到 ${frame.owner} 和另一个玩家`);
    }
    return {
      position: screenPositionFor(frame.owner),
      owner: frame.owner,
      packetLength,
      own: { name: ownRecord.name, score: ownRecord.score, secret: frame.secrets[0] },
      other: { name: otherRecord.name, score: otherRecord.score, secret: null },
    };
  }

  // A leak frame never reaches a screen; validation rejects it upstream.
  reject(REJECT.LEAK_DETECTED, '34 字节的包同时带着两个暗格，不能画到任何屏幕');
}

export function renderScreens(
  config: RoomConfig,
  packets: {
    public: { bytes: Uint8Array; decoded: ParsedFrame };
    byOwner: Record<OwnerName, { bytes: Uint8Array; decoded: ParsedFrame }>;
  },
): Screens {
  const publicScreen = drawScreenFromPacket(packets.public.decoded, packets.public.bytes.byteLength) as PublicScreen;

  const byOwner = {} as Record<OwnerName, PlayerScreen>;
  for (const owner of config.players as readonly OwnerName[]) {
    byOwner[owner] = drawScreenFromPacket(
      packets.byOwner[owner].decoded,
      packets.byOwner[owner].bytes.byteLength,
    ) as PlayerScreen;
  }

  return {
    public: publicScreen,
    byOwner,
    layout: { top: publicScreen, left: byOwner['甲'], right: byOwner['乙'] },
  };
}

function assertIntegerOrNull(value: number | null, label: string): void {
  if (value !== null && !Number.isInteger(value)) {
    reject(REJECT.NON_INTEGER, `${label} 必须是整数或空格，收到 ${value}`);
  }
}

/**
 * "左邊如果畫出 17，或者右邊畫出 41，我退回。上方如果畫出其中任何一個，也退回。"
 *
 * Reads secret cells off the screens and compares them with the room's
 * canonical assignment. Empty is allowed only for the *other* player's cell on
 * a private screen — the owner always draws a number.
 */
export function assertScreenValues(config: RoomConfig, screens: Screens): void {
  const [first, second] = config.players as readonly OwnerName[];

  if (screens.public.cells.length !== 2) {
    reject(REJECT.PUBLIC_SCREEN_HAS_SECRET, `公共屏必须有两个分数，收到 ${screens.public.cells.length} 个格子`);
  }
  for (const cell of screens.public.cells) {
    assertIntegerOrNull(cell.secret, '公共屏的暗格栏');
    if (cell.secret !== null) {
      reject(REJECT.PUBLIC_SCREEN_HAS_SECRET, `公共屏上出现了暗格 ${cell.secret}`);
    }
  }
  if (screens.public.packetLength !== CANONICAL_PUBLIC_LENGTH) {
    reject(
      REJECT.PUBLIC_LENGTH,
      `公共屏的包是 ${screens.public.packetLength} 字节，应为 ${CANONICAL_PUBLIC_LENGTH}`,
    );
  }

  for (const owner of [first, second]) {
    const screen = screens.byOwner[owner];
    if (screen === undefined) {
      reject(REJECT.MISSING_PACKET, `缺少 ${owner} 的屏幕`);
    }
    const ownIndex = config.players.indexOf(owner);
    const otherIndex = 1 - ownIndex;

    if (screen.own.name !== owner) {
      reject(REJECT.SCREEN_PACKET_MISMATCH, `${owner} 的屏幕主格写着 ${screen.own.name}`);
    }
    if (screen.own.score !== config.scores[ownIndex]) {
      reject(
        REJECT.WRONG_SCORE,
        `${owner} 的屏幕分数是 ${screen.own.score}，应为 ${config.scores[ownIndex]}`,
      );
    }
    assertIntegerOrNull(screen.own.secret, `${owner} 的暗格`);
    if (screen.own.secret !== config.secrets[ownIndex]) {
      reject(
        REJECT.SCREEN_PACKET_MISMATCH,
        `${owner} 的屏幕暗格是 ${screen.own.secret}，应为 ${config.secrets[ownIndex]}`,
      );
    }

    if (screen.other.name !== config.players[otherIndex]) {
      reject(REJECT.SCREEN_PACKET_MISMATCH, `${owner} 的屏幕另一格写着 ${screen.other.name}`);
    }
    if (screen.other.score !== config.scores[otherIndex]) {
      reject(
        REJECT.WRONG_SCORE,
        `${owner} 的屏幕上 ${screen.other.name} 的分数是 ${screen.other.score}，应为 ${config.scores[otherIndex]}`,
      );
    }
    if (screen.other.secret !== null) {
      reject(
        REJECT.OTHER_SECRET_VISIBLE,
        `${owner} 的屏幕上读到了别人的暗格 ${screen.other.secret}；那一格必须是空的`,
      );
    }
    if (screen.packetLength !== 0 && screen.packetLength === CANONICAL_PUBLIC_LENGTH) {
      reject(REJECT.PRIVATE_HAS_NO_SECRET, `${owner} 的屏幕后面是 26 字节的公共包，不含暗格`);
    }
  }
}

/**
 * Screens must be a pure function of their packets. This is what makes
 * "只修屏幕、包里仍是 17" observable: the length and the numbers on the screen
 * are re-derived from the packet, never trusted from the screen object.
 */
export function assertScreensMatchPackets(
  config: RoomConfig,
  screens: Screens,
  packets: {
    public: { bytes: Uint8Array; decoded: ParsedFrame };
    byOwner: Record<OwnerName, { bytes: Uint8Array; decoded: ParsedFrame }>;
  },
): void {
  if (packets.public.bytes.byteLength !== screens.public.packetLength) {
    reject(REJECT.SCREEN_PACKET_MISMATCH, '公共屏的字节长度与它的包不一致');
  }
  for (const owner of config.players as readonly OwnerName[]) {
    const packet = packets.byOwner[owner];
    if (packet === undefined) {
      reject(REJECT.MISSING_PACKET, `${owner} 的屏幕没有对应的包`);
    }
    if (packet.bytes.byteLength !== screens.byOwner[owner].packetLength) {
      reject(REJECT.SCREEN_PACKET_MISMATCH, `${owner} 的屏幕的字节长度与它的包不一致`);
    }
    const expected = drawScreenFromPacket(packet.decoded, packet.bytes.byteLength) as PlayerScreen;
    const actual = screens.byOwner[owner];
    if (actual.own.secret !== expected.own.secret || actual.own.score !== expected.own.score) {
      reject(
        REJECT.SCREEN_PACKET_MISMATCH,
        `${owner} 的屏幕画的是 ${actual.own.score}/${actual.own.secret}，` +
          `但包里是 ${expected.own.score}/${expected.own.secret}`,
      );
    }
    if (actual.other.score !== expected.other.score || actual.other.secret !== null) {
      reject(
        REJECT.SCREEN_PACKET_MISMATCH,
        `${owner} 的屏幕上另一格与包不一致（包是 ${expected.other.score} / 空）`,
      );
    }
  }

  const expectedPublic = drawScreenFromPacket(packets.public.decoded, packets.public.bytes.byteLength) as PublicScreen;
  const actualPublic = screens.public;
  for (let i = 0; i < expectedPublic.cells.length; i++) {
    if (
      actualPublic.cells[i]?.name !== expectedPublic.cells[i].name ||
      actualPublic.cells[i]?.score !== expectedPublic.cells[i].score ||
      actualPublic.cells[i]?.secret !== null
    ) {
      reject(REJECT.PUBLIC_SCREEN_HAS_SECRET, '公共屏的内容与它的包不一致，或其中出现了暗格');
    }
  }
}

/**
 * The preview constraint: the shared screen hangs above the room, 甲 on the
 * left, 乙 on the right. Nothing else is an acceptable layout.
 *
 * The secret numbers are checked against the room's own config, not against
 * the literals 41 / 17: when 甲's secret changes, the left panel must change
 * with it and stay correct.
 */
export function assertPreviewLayout(config: RoomConfig, screens: Screens): void {
  const { layout } = screens;
  const [first, second] = config.players as readonly OwnerName[];

  if (first !== '甲' || second !== '乙') {
    reject(REJECT.WRONG_LAYOUT, `左边是甲、右边是乙；这一局是 ${first} / ${second}`);
  }
  if (layout.top.position !== 'top') {
    reject(REJECT.WRONG_LAYOUT, '公共屏必须挂在房间上方');
  }
  if (layout.top.cells.some((cell) => cell.secret !== null)) {
    reject(REJECT.PUBLIC_SCREEN_HAS_SECRET, '上方那块没有暗格');
  }
  if (layout.left.position !== 'left' || layout.left.owner !== '甲') {
    reject(REJECT.WRONG_LAYOUT, '左边必须是甲');
  }
  if (layout.right.position !== 'right' || layout.right.owner !== '乙') {
    reject(REJECT.WRONG_LAYOUT, '右边必须是乙');
  }
  if (layout.left.own.secret !== config.secrets[0]) {
    reject(
      REJECT.SCREEN_PACKET_MISMATCH,
      `左边（甲）应画出 ${config.secrets[0]}，实际画出 ${layout.left.own.secret}`,
    );
  }
  if (layout.right.own.secret !== config.secrets[1]) {
    reject(
      REJECT.SCREEN_PACKET_MISMATCH,
      `右边（乙）应画出 ${config.secrets[1]}，实际画出 ${layout.right.own.secret}`,
    );
  }
  if (layout.left.other.secret !== null) {
    reject(REJECT.OTHER_SECRET_VISIBLE, '左边的另一格没画空');
  }
  if (layout.right.other.secret !== null) {
    reject(REJECT.OTHER_SECRET_VISIBLE, '右边的另一格没画空');
  }
}
