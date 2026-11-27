import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANONICAL_ROOM,
  REJECT,
  assertCompleteRoom,
  buildDelivery,
  createRoomPackets,
  inspectRoom,
  packetLengths,
  renderScreens,
  type RoomConfig,
  type RoomPackets,
} from '../src/index.ts';

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe('combined delivery', () => {
  it('三包齐备：26 · 30 · 30', () => {
    const delivery = buildDelivery(CANONICAL_ROOM);
    assert.deepEqual(packetLengths(delivery), [26, 30, 30]);
    assert.equal(delivery.bundles.length, 3);
    assert.equal(delivery.screens.layout.top.packetLength, 26);
    assert.equal(delivery.screens.layout.left.packetLength, 30);
    assert.equal(delivery.screens.layout.right.packetLength, 30);
  });

  it('甲和乙的包各自带自己的暗格', () => {
    const delivery = buildDelivery(CANONICAL_ROOM);
    assert.deepEqual(delivery.packets.byOwner['甲'].decoded.secrets, [41]);
    assert.deepEqual(delivery.packets.byOwner['乙'].decoded.secrets, [17]);
  });

  it('只交公共 + 甲、缺乙，退回', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const partial = {
      ...packets,
      byOwner: { 甲: packets.byOwner['甲'] },
      all: [packets.public, packets.byOwner['甲']],
    } as unknown as RoomPackets;
    assert.throws(
      () => assertCompleteRoom(CANONICAL_ROOM, partial),
      (error) => code(error) === REJECT.INCOMPLETE_BUNDLE,
    );
  });

  it('只交甲、乙两边，缺公共，退回', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const partial = { ...packets, public: undefined } as unknown as RoomPackets;
    assert.throws(
      () => assertCompleteRoom(CANONICAL_ROOM, partial),
      (error) => code(error) === REJECT.INCOMPLETE_BUNDLE || error instanceof TypeError,
    );
  });

  it('甲的包被换成 26 字节的公共帧，退回', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const broken = {
      ...packets,
      byOwner: {
        ...packets.byOwner,
        甲: { ...packets.public, recipient: '甲' },
      },
    } as RoomPackets;
    const screens = renderScreens(CANONICAL_ROOM, packets);
    assert.throws(
      () => inspectRoom(CANONICAL_ROOM, broken, screens),
      (error) => code(error) === REJECT.INCOMPLETE_BUNDLE || code(error) === REJECT.PRIVATE_LENGTH,
    );
  });

  it('改一个分数，包和屏跟着变', () => {
    const config: RoomConfig = { ...CANONICAL_ROOM, scores: [9, 12] };
    const delivery = buildDelivery(config);
    assert.deepEqual(delivery.packets.public.decoded.records.map((r) => r.score), [9, 12]);
    assert.equal(delivery.screens.layout.top.cells[0].score, 9);
    assert.equal(delivery.screens.layout.left.own.score, 9);
  });
});
