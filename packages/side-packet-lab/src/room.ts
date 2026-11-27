/**
 * The room: three packets per tick, then the per-recipient bundles, then the
 * three screens.
 *
 * Two delivery strategies are provided. The lab does not mandate one:
 *
 *   - 'split-on-send'     — the encoder is handed only the owner's secret, so a
 *                           private packet is born with one secret slot and
 *                           never contains the other player's number at any
 *                           point on the wire.
 *   - 'filter-on-receive' — the room state holds both secrets internally, but
 *                           the per-viewer projection reads only the viewer's
 *                           slot before anything leaves the room. The received
 *                           packet is already stripped, and the screen is drawn
 *                           from that packet.
 *
 * Both must agree byte-for-byte: 26 / 30 / 30, 甲 sees 41 and not 17, 乙 sees
 * 17 and not 41, and the shared screen sees neither.
 */

import {
  decodeFrame,
  encodePrivateFrame,
  encodePublicFrame,
  type ParsedFrame,
  type PlayerRecord,
} from './codec.ts';
import {
  PUBLIC_RECIPIENT,
  REJECT,
  reject,
  type OwnerName,
} from './protocol.ts';
import { CANONICAL_ROOM, expectedRecords, validateForRecipient, type RoomConfig } from './validate.ts';

export type DeliveryStrategy = 'split-on-send' | 'filter-on-receive';

export interface Packet {
  recipient: string;
  kind: 'public' | 'private';
  bytes: Uint8Array;
  length: number;
  decoded: ParsedFrame;
}

export interface RoomPackets {
  public: Packet;
  byOwner: Record<OwnerName, Packet>;
  /** All three packets, in inspection order: public first, then 甲, then 乙. */
  all: Packet[];
}

export interface Bundle {
  recipient: string;
  packets: Packet[];
}

function packetFor(recipient: string, kind: 'public' | 'private', bytes: Uint8Array): Packet {
  return { recipient, kind, bytes, length: bytes.byteLength, decoded: decodeFrame(bytes) };
}

function buildPublicPacket(config: RoomConfig): Packet {
  const bytes = encodePublicFrame(0, expectedRecords(config));
  return packetFor(PUBLIC_RECIPIENT, 'public', bytes);
}

function buildPrivatePacket(config: RoomConfig, owner: OwnerName): Packet {
  const ownerIndex = config.players.indexOf(owner);
  const secret = config.secrets[ownerIndex];
  const bytes = encodePrivateFrame(0, expectedRecords(config), owner, secret);
  return packetFor(owner, 'private', bytes);
}

/**
 * Per-viewer projection used by 'filter-on-receive'. It reads the viewer's own
 * slot out of the authoritative room state; the other slot is never copied
 * into the packet.
 */
function projectForViewer(config: RoomConfig, owner: OwnerName): { records: PlayerRecord[]; secret: number } {
  const ownerIndex = config.players.indexOf(owner);
  return { records: expectedRecords(config), secret: config.secrets[ownerIndex] };
}

export function createRoomPackets(
  config: RoomConfig = CANONICAL_ROOM,
  strategy: DeliveryStrategy = 'split-on-send',
): RoomPackets {
  const publicPacket = buildPublicPacket(config);

  const players = config.players as readonly [OwnerName, OwnerName];
  const privatePackets = players.map((owner): Packet => {
    if (strategy === 'split-on-send') {
      return buildPrivatePacket(config, owner);
    }
    const projected = projectForViewer(config, owner);
    return packetFor(owner, 'private', encodePrivateFrame(0, projected.records, owner, projected.secret));
  });

  const byOwner = {
    [players[0]]: privatePackets[0],
    [players[1]]: privatePackets[1],
  } as Record<OwnerName, Packet>;

  return { public: publicPacket, byOwner, all: [publicPacket, ...privatePackets] };
}

/**
 * Hand each packet to its audience: the public packet to the shared screen, and
 * each private packet to its owner. A player's own packet already carries both
 * names and both scores, so it is the only packet that player needs — nothing
 * of the other player's secret travels with it.
 *
 * Every bundle is validated before it leaves the room, so a leak cannot be
 * produced here.
 */
export function fanOut(config: RoomConfig, packets: RoomPackets): Bundle[] {
  const recipients = [PUBLIC_RECIPIENT, ...(config.players as readonly OwnerName[])];
  return recipients.map((recipient) => {
    const own = recipient === PUBLIC_RECIPIENT
      ? [packets.public]
      : [packets.byOwner[recipient]];

    for (const packet of own) {
      validateForRecipient(config, packet.decoded, recipient);
    }

    return { recipient, packets: own };
  });
}

export function bundleFor(bundles: readonly Bundle[], recipient: string): Bundle {
  const bundle = bundles.find((entry) => entry.recipient === recipient);
  if (bundle === undefined) {
    reject(REJECT.MISSING_PACKET, `没有发给 ${recipient} 的包`);
  }
  return bundle;
}

/** Reject the same recipient appearing twice, or a recipient with no packet. */
export function assertNoDuplicateBundles(bundles: readonly Bundle[]): void {
  const seen = new Set<string>();
  for (const bundle of bundles) {
    if (seen.has(bundle.recipient)) {
      reject(REJECT.DUPLICATE_PACKET, `${bundle.recipient} 收到了两组包`);
    }
    seen.add(bundle.recipient);
    if (bundle.packets.length === 0) {
      reject(REJECT.MISSING_PACKET, `${bundle.recipient} 没有收到任何包`);
    }
  }
}

/**
 * A complete room is exactly three packets: the 26-byte public one, and two
 * 30-byte private ones. "只做了公共、甲的包里仍读得出 17，也退回" — one public
 * packet alone is not a room; the two private packets must be present too.
 */
export function assertCompleteRoom(config: RoomConfig, packets: RoomPackets): void {
  if (packets.public.kind !== 'public') {
    reject(REJECT.PUBLIC_NOT_PUBLIC, '公共那一路必须是公共包');
  }
  for (const owner of config.players as readonly OwnerName[]) {
    if (packets.byOwner[owner] === undefined) {
      reject(REJECT.INCOMPLETE_BUNDLE, `缺少 ${owner} 的包；只做了甲或只做了乙都不算数`);
    }
    if (packets.byOwner[owner].kind !== 'private') {
      reject(REJECT.INCOMPLETE_BUNDLE, `${owner} 的包不是 30 字节的私有帧`);
    }
  }
  if (packets.all.length !== 3) {
    reject(REJECT.INCOMPLETE_BUNDLE, `一次完整交付是三包，收到 ${packets.all.length} 包`);
  }
}
