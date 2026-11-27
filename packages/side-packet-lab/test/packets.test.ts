import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANONICAL_LEAK_LENGTH,
  CANONICAL_NAMES,
  CANONICAL_PRIVATE_LENGTH,
  CANONICAL_PUBLIC_LENGTH,
  CANONICAL_ROOM,
  CANONICAL_SCORES,
  CANONICAL_SECRETS,
  REJECT,
  type RoomConfig,
  bundleFor,
  createRoomPackets,
  encodeLeakFrame,
  encodePrivateFrame,
  encodePublicFrame,
  fanOut,
  frameLength,
  inspectRaw,
  KIND,
} from '../src/index.ts';

const PLAYER_RECORDS = [
  { name: '甲', score: 8 },
  { name: '乙', score: 12 },
];

function roomWith(overrides: Partial<RoomConfig>): RoomConfig {
  return { ...CANONICAL_ROOM, ...overrides };
}

describe('length contract', () => {
  it('公共包是 26 字节', () => {
    const bytes = encodePublicFrame(0, PLAYER_RECORDS);
    assert.equal(frameLength(bytes), CANONICAL_PUBLIC_LENGTH);
    assert.equal(frameLength(bytes), 26);
  });

  it('甲和乙的包都是 30 字节', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    assert.equal(frameLength(packets.byOwner['甲'].bytes), 30);
    assert.equal(frameLength(packets.byOwner['乙'].bytes), 30);
  });

  it('两包长度相同，只靠长度分不出谁拿了哪个暗格', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    assert.equal(packets.byOwner['甲'].length, packets.byOwner['乙'].length);
    assert.notEqual(
      Buffer.from(packets.byOwner['甲'].bytes).toString('hex'),
      Buffer.from(packets.byOwner['乙'].bytes).toString('hex'),
    );
  });

  it('把两个暗格塞进同一包是 34 字节', () => {
    const bytes = encodeLeakFrame(0, PLAYER_RECORDS, [41, 17]);
    assert.equal(frameLength(bytes), CANONICAL_LEAK_LENGTH);
    assert.equal(frameLength(bytes), 34);
    assert.equal(CANONICAL_LEAK_LENGTH - CANONICAL_PRIVATE_LENGTH, 4);
  });

  it('三包长度的和是 26 + 30 + 30', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    assert.deepEqual(packets.all.map((packet) => packet.length), [26, 30, 30]);
  });

  it('名字会用 UTF-8 字节数改变包长', () => {
    // 甲 / 乙 are 3 bytes each; a 1-byte name shifts the per-record cost by 2.
    const shorter = encodePublicFrame(0, [
      { name: 'A', score: 8 },
      { name: 'B', score: 12 },
    ]);
    assert.equal(frameLength(shorter), 22);
    const longer = encodePublicFrame(0, [
      { name: 'Alexander', score: 8 },
      { name: 'Beatrice', score: 12 },
    ]);
    assert.notEqual(frameLength(longer), CANONICAL_PUBLIC_LENGTH);
  });
});

describe('the three canonical packets', () => {
  it('甲包里是 41，乙包里是 17', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    assert.deepEqual(packets.byOwner['甲'].decoded.secrets, [41]);
    assert.deepEqual(packets.byOwner['乙'].decoded.secrets, [17]);
  });

  it('公共包里既没有 41 也没有 17', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    assert.equal(packets.public.decoded.kind, 'public');
    assert.deepEqual(packets.public.decoded.secrets, []);

    // The secret slot is structurally absent, not blanked: the records end
    // exactly at the last byte, so there are no bytes that could carry 41 / 17.
    const raw = inspectRaw(packets.public.bytes);
    assert.ok(raw !== null);
    assert.equal(raw.trailingBytes, 0);
    assert.equal(raw.totalLength, 26);
    assert.equal(raw.declaredKind, KIND.PUBLIC);
  });

  it('公共包里只有 8 和 12 两个分数', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    assert.deepEqual(
      packets.public.decoded.records.map((record) => record.score),
      [8, 12],
    );
  });

  it('每个私有包里也带着两个分数', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    for (const owner of CANONICAL_NAMES) {
      assert.deepEqual(
        packets.byOwner[owner].decoded.records.map((record) => [record.name, record.score]),
        [['甲', 8], ['乙', 12]],
      );
    }
  });
});

describe('changing a secret', () => {
  it('甲的暗格改了，甲包跟着变，乙包和公共包一个字节都不变', () => {
    const before = createRoomPackets(CANONICAL_ROOM);
    const changed = createRoomPackets(roomWith({ secrets: [42, 17] }));
    const after = createRoomPackets(roomWith({ secrets: [42, 17] }));

    assert.deepEqual(changed.byOwner['甲'].decoded.secrets, [42]);
    assert.deepEqual(changed.byOwner['乙'].decoded.secrets, [17]);

    assert.notDeepEqual(
      Buffer.from(changed.byOwner['甲'].bytes),
      Buffer.from(before.byOwner['甲'].bytes),
    );
    assert.deepEqual(
      Buffer.from(changed.byOwner['乙'].bytes),
      Buffer.from(before.byOwner['乙'].bytes),
    );
    assert.deepEqual(
      Buffer.from(changed.public.bytes),
      Buffer.from(before.public.bytes),
    );

    // Deterministic: the same room config re-encodes to identical bytes.
    assert.deepEqual(
      Buffer.from(after.byOwner['甲'].bytes),
      Buffer.from(changed.byOwner['甲'].bytes),
    );
  });

  it('改了甲的暗格之后，乙的包里仍然读不到这个数', () => {
    const changed = createRoomPackets(roomWith({ secrets: [42, 17] }));
    assert.deepEqual(changed.byOwner['乙'].decoded.secrets, [17]);
    const hex = Buffer.from(changed.byOwner['乙'].bytes).toString('hex');
    assert.ok(!hex.includes('2a'), '乙的包读出了 42');
  });
});

describe('both delivery strategies agree', () => {
  it('发出时拆开与各端自己滤出同样的三包', () => {
    const split = createRoomPackets(CANONICAL_ROOM, 'split-on-send');
    const filtered = createRoomPackets(CANONICAL_ROOM, 'filter-on-receive');

    assert.deepEqual(split.all.map((packet) => packet.length), filtered.all.map((packet) => packet.length));
    for (const packetIndex of [0, 1, 2]) {
      assert.deepEqual(
        Buffer.from(split.all[packetIndex].bytes),
        Buffer.from(filtered.all[packetIndex].bytes),
      );
    }
  });

  it('两条路上甲都是 41、没有 17，乙都是 17、没有 41', () => {
    for (const strategy of ['split-on-send', 'filter-on-receive'] as const) {
      const packets = createRoomPackets(CANONICAL_ROOM, strategy);
      assert.deepEqual(packets.byOwner['甲'].decoded.secrets, [41]);
      assert.deepEqual(packets.byOwner['乙'].decoded.secrets, [17]);
      assert.deepEqual(packets.public.decoded.secrets, []);
    }
  });
});

describe('bundles', () => {
  it('每个人只收到自己的那一包', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const bundles = fanOut(CANONICAL_ROOM, packets);

    const publicBundle = bundleFor(bundles, 'public');
    assert.equal(publicBundle.packets.length, 1);
    assert.equal(publicBundle.packets[0].length, 26);

    const jia = bundleFor(bundles, '甲');
    assert.equal(jia.packets.length, 1);
    assert.equal(jia.packets[0].length, 30);
    assert.deepEqual(jia.packets[0].decoded.kind, 'private');
    assert.deepEqual((jia.packets[0].decoded as { secrets: number[] }).secrets, [41]);

    const yi = bundleFor(bundles, '乙');
    assert.equal(yi.packets.length, 1);
    assert.deepEqual((yi.packets[0].decoded as { secrets: number[] }).secrets, [17]);
  });

  it('只做公共那一包、甲包里仍能读出 17，会被退回', () => {
    // The bad build: the public packet claims to be private and carries 17.
    const publicBytes = encodePublicFrame(0, PLAYER_RECORDS);
    const leakedToJia = encodePrivateFrame(0, PLAYER_RECORDS, '甲', 17);
    const packets = createRoomPackets(CANONICAL_ROOM);
    const broken = {
      ...packets,
      byOwner: { ...packets.byOwner, 甲: { ...packets.byOwner['甲'], bytes: leakedToJia, decoded: { kind: 'private' as const, owner: '甲' as const, recipient: '甲' as const, roomTag: 0, records: PLAYER_RECORDS, secrets: [17] as [number] } } },
    };

    assert.throws(
      () => fanOut(CANONICAL_ROOM, broken),
      (error: unknown) => (error as { code?: string }).code === REJECT.SWAPPED_SECRET,
    );

    // And the honest public packet alone is not a private packet at all.
    assert.equal(publicBytes.byteLength, 26);
  });
});
