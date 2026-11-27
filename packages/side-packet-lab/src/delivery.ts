/**
 * The single delivery the lab accepts: three packets — public 26, 甲 30 with
 * 41, 乙 30 with 17 — handed out together, plus the three screens drawn from
 * them.
 *
 * "这两块屏幕要一起交" — a partial delivery is rejected, not silently
 * completed. Missing 甲, missing 乙, or missing the public packet all fail.
 */

import {
  CANONICAL_PRIVATE_LENGTH,
  CANONICAL_PUBLIC_LENGTH,
  REJECT,
  reject,
  type OwnerName,
} from './protocol.ts';
import type { RoomConfig } from './validate.ts';
import {
  type Bundle,
  type RoomPackets,
  assertCompleteRoom,
  createRoomPackets,
  fanOut,
  assertNoDuplicateBundles,
} from './room.ts';
import { renderScreens, type Screens } from './screens.ts';

export interface Delivery {
  packets: RoomPackets;
  bundles: Bundle[];
  screens: Screens;
}

export function buildDelivery(config: RoomConfig): Delivery {
  const packets = createRoomPackets(config, 'split-on-send');
  assertCompleteRoom(config, packets);
  const bundles = fanOut(config, packets);

  if (bundles.length !== 3) {
    reject(REJECT.INCOMPLETE_BUNDLE, `一次完整交付是三组包（公共 / 甲 / 乙），收到 ${bundles.length} 组`);
  }
  assertNoDuplicateBundles(bundles);

  const forPublic = bundles.find((bundle) => bundle.recipient === 'public');
  const forJia = bundles.find((bundle) => bundle.recipient === '甲');
  const forYi = bundles.find((bundle) => bundle.recipient === '乙');
  if (forPublic === undefined || forJia === undefined || forYi === undefined) {
    reject(REJECT.INCOMPLETE_BUNDLE, '公共、甲、乙三组包必须一起交');
  }
  if (forPublic.packets.length !== 1 || forPublic.packets[0].length !== CANONICAL_PUBLIC_LENGTH) {
    reject(REJECT.PUBLIC_LENGTH, `公共那一组应是一包 ${CANONICAL_PUBLIC_LENGTH} 字节`);
  }
  for (const [bundle, owner] of [[forJia, '甲'], [forYi, '乙']] as const) {
    if (bundle.packets.length !== 1 || bundle.packets[0].length !== CANONICAL_PRIVATE_LENGTH) {
      reject(REJECT.PRIVATE_LENGTH, `${owner} 那一组应是一包 ${CANONICAL_PRIVATE_LENGTH} 字节`);
    }
  }

  const screens = renderScreens(config, packets);

  // Three packets, two screens, one public screen. All of it, or nothing.
  if (screens.layout.top === undefined || screens.layout.left === undefined || screens.layout.right === undefined) {
    reject(REJECT.INCOMPLETE_BUNDLE, '公共屏、左屏、右屏必须一起交');
  }
  for (const owner of config.players as readonly OwnerName[]) {
    if (screens.byOwner[owner] === undefined) {
      reject(REJECT.INCOMPLETE_BUNDLE, `缺少 ${owner} 的屏幕`);
    }
  }

  return { packets, bundles, screens };
}

/** The three packet lengths, in inspection order. */
export function packetLengths(delivery: Delivery): [number, number, number] {
  const lengths = delivery.packets.all.map((packet) => packet.length);
  if (lengths.length !== 3) {
    reject(REJECT.INCOMPLETE_BUNDLE, `应有三个包，收到 ${lengths.length} 个`);
  }
  return [lengths[0], lengths[1], lengths[2]];
}
