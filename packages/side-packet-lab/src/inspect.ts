/**
 * Per-endpoint reception and packet inspection.
 *
 * Two separate gates:
 *
 *   1. receive — what each endpoint accepts from the wire. Anything carrying a
 *      number that is not its own secret is rejected before rendering.
 *   2. inspect — what the operator sees when the room is opened: packets
 *      first, screens second. A 30-byte packet is only identifiable by the
 *      secret it carries; reporting the length alone is ambiguous.
 */

import {
  CANONICAL_PRIVATE_LENGTH,
  CANONICAL_PUBLIC_LENGTH,
  PUBLIC_RECIPIENT,
  REJECT,
  reject,
  type OwnerName,
} from './protocol.ts';
import { validateForRecipient, type RoomConfig } from './validate.ts';
import type { Bundle, Packet, RoomPackets } from './room.ts';
import { assertCompleteRoom } from './room.ts';
import { decodeFrame } from './codec.ts';
import { assertScreenValues, assertScreensMatchPackets, assertPreviewLayout, type Screens } from './screens.ts';

export interface ReceivedBundle {
  recipient: string;
  packets: Packet[];
}

/**
 * Deliver a bundle to one endpoint and validate every packet against that
 * endpoint's expectations. This is the "乙这边读到 41，退回" gate: the packet
 * is decoded and checked, not merely length-checked.
 */
export function receiveBundle(config: RoomConfig, bundle: Bundle, recipient: string): ReceivedBundle {
  if (bundle.recipient !== recipient) {
    reject(REJECT.WRONG_OWNER, `这一组包是发给 ${bundle.recipient} 的，不是 ${recipient}`);
  }

  const accepted: Packet[] = [];
  for (const packet of bundle.packets) {
    validateForRecipient(config, packet.decoded, recipient);
    accepted.push(packet);
  }

  if (accepted.length === 0) {
    reject(REJECT.MISSING_PACKET, `${recipient} 没有收到任何包`);
  }

  return { recipient, packets: accepted };
}

export interface PacketReport {
  /** Total bytes of the packet. */
  length: number;
  /** The secret the packet carries, or `null` for the public packet. */
  secret: number | null;
  /** The recipient the packet is addressed to. */
  recipient: string;
  /** The scores found on the packet. */
  scores: number[];
}

export interface RoomInspection {
  packets: PacketReport[];
  screens: {
    top: { length: number; scores: number[]; secret: number | null };
    left: { length: number; own: { score: number; secret: number }; other: { score: number; secret: null } };
    right: { length: number; own: { score: number; secret: number }; other: { score: number; secret: null } };
  };
}

/**
 * A 30-byte packet is indistinguishable from its twin by length alone. Its
 * identity — and therefore the screen it belongs to — is only known once the
 * secret is read. A report that gives the length but withholds the secret is
 * rejected rather than guessed at.
 */
export function assertInspectionDistinguishesOwners(reports: readonly PacketReport[]): void {
  const privateReports = reports.filter((report) => report.length === CANONICAL_PRIVATE_LENGTH);
  if (privateReports.length !== 2) {
    reject(
      REJECT.INCOMPLETE_BUNDLE,
      `30 字节的包应有两个，收到 ${privateReports.length} 个`,
    );
  }
  for (const report of privateReports) {
    if (report.secret === null) {
      reject(
        REJECT.AMBIGUOUS_INSPECTION,
        '只报一个 30，不报暗格是 41 还是 17，就分不出甲和乙；退回',
      );
    }
  }
  const [a, b] = privateReports;
  if (a.secret === b.secret) {
    reject(
      REJECT.AMBIGUOUS_INSPECTION,
      `两包都写成 ${a.secret}，长度一样、暗格一样，分不出甲和乙；退回`,
    );
  }
}

function reportForPacket(packet: Packet): PacketReport {
  // Trust the wire: decode the bytes afresh rather than the packet object, so
  // a packet whose `decoded` was tampered with cannot pass inspection.
  const decoded = decodeFrame(packet.bytes);
  return {
    length: packet.bytes.byteLength,
    secret: decoded.kind === 'public' ? null : decoded.secrets[0],
    recipient: packet.recipient,
    scores: decoded.records.map((record) => record.score),
  };
}

/**
 * "我打开房间之后先看包，再看屏幕。"
 *
 * Packets are checked first: the 26-byte one must carry only the two scores,
 * and each 30-byte one must be identified by its secret. Only then are the
 * screens checked, and only against the packets that produced them.
 */
export function inspectRoom(config: RoomConfig, packets: RoomPackets, screens: Screens): RoomInspection {
  assertCompleteRoom(config, packets);

  // Re-decode every packet from its bytes and validate it against the
  // recipient it claims to be for. Inspection trusts the wire, not the packet
  // object: a 34-byte leak relabelled as 30 is caught here.
  validateForRecipient(config, packets.public.decoded, PUBLIC_RECIPIENT);
  for (const owner of config.players as readonly OwnerName[]) {
    const packet = packets.byOwner[owner];
    if (packet.bytes.byteLength !== CANONICAL_PRIVATE_LENGTH) {
      reject(REJECT.PRIVATE_LENGTH, `${owner} 的包是 ${packet.bytes.byteLength} 字节，应为 ${CANONICAL_PRIVATE_LENGTH}`);
    }
    validateForRecipient(config, packet.decoded, owner);
  }

  const reports = packets.all.map(reportForPacket);
  if (reports[0].length !== CANONICAL_PUBLIC_LENGTH) {
    reject(REJECT.PUBLIC_LENGTH, `公共包是 ${reports[0].length} 字节，应为 ${CANONICAL_PUBLIC_LENGTH}`);
  }
  if (reports[0].secret !== null) {
    reject(REJECT.PUBLIC_HAS_SECRET, `公共包里读出了暗格 ${reports[0].secret}`);
  }
  if (reports[0].scores.length !== 2 || reports[0].scores[0] !== config.scores[0] || reports[0].scores[1] !== config.scores[1]) {
    reject(
      REJECT.WRONG_SCORE,
      `公共包里只有两个分数：${config.scores[0]} 和 ${config.scores[1]}；读到 ${reports[0].scores.join(' / ')}`,
    );
  }

  const privateReports = reports.slice(1);
  for (const report of privateReports) {
    if (report.length !== CANONICAL_PRIVATE_LENGTH) {
      reject(REJECT.PRIVATE_LENGTH, `私有包是 ${report.length} 字节，应为 ${CANONICAL_PRIVATE_LENGTH}`);
    }
    if (report.secret === null) {
      reject(REJECT.PRIVATE_HAS_NO_SECRET, '30 字节的包里读不出暗格');
    }
    if (!config.players.includes(report.recipient)) {
      reject(REJECT.THIRD_PERSON, `包里写着收件人 ${report.recipient}`);
    }
  }
  assertInspectionDistinguishesOwners(reports);

  // Packets are inspected and identified. Now the screens.
  assertScreenValues(config, screens);
  assertScreensMatchPackets(config, screens, packets);
  assertPreviewLayout(config, screens);

  const leftReport = reports.find((report) => report.recipient === '甲');
  const rightReport = reports.find((report) => report.recipient === '乙');
  if (leftReport === undefined || rightReport === undefined) {
    reject(REJECT.INCOMPLETE_BUNDLE, '少了一个人的包');
  }

  return {
    packets: reports,
    screens: {
      top: { length: screens.public.packetLength, scores: screens.public.cells.map((cell) => cell.score), secret: null },
      left: {
        length: screens.layout.left.packetLength,
        own: { score: screens.layout.left.own.score, secret: screens.layout.left.own.secret },
        other: { score: screens.layout.left.other.score, secret: null },
      },
      right: {
        length: screens.layout.right.packetLength,
        own: { score: screens.layout.right.own.score, secret: screens.layout.right.own.secret },
        other: { score: screens.layout.right.other.score, secret: null },
      },
    },
  };
}

export { PUBLIC_RECIPIENT };
export type { OwnerName };
