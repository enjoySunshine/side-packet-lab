import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANONICAL_ROOM,
  REJECT,
  assertScreensMatchPackets,
  assertPreviewLayout,
  assertScreenValues,
  assertInspectionDistinguishesOwners,
  createRoomPackets,
  decodeFrame,
  drawScreenFromPacket,
  encodePrivateFrame,
  encodeLeakFrame,
  fanOut,
  inspectRoom,
  receiveBundle,
  renderScreens,
  validateForRecipient,
  type PlayerScreen,
  type PublicScreen,
  type Screens,
} from '../src/index.ts';

const RECORDS = [
  { name: '甲', score: 8 },
  { name: '乙', score: 12 },
];

function canonicalScreens(): { packets: ReturnType<typeof createRoomPackets>; screens: Screens } {
  const packets = createRoomPackets(CANONICAL_ROOM);
  return { packets, screens: renderScreens(CANONICAL_ROOM, packets) };
}

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe('screens are a projection of packets', () => {
  it('甲的屏幕上分数 8、暗格 41；乙的分数 12、暗格空', () => {
    const { screens } = canonicalScreens();
    const left = screens.layout.left;
    assert.equal(left.position, 'left');
    assert.equal(left.own.name, '甲');
    assert.equal(left.own.score, 8);
    assert.equal(left.own.secret, 41);
    assert.equal(left.other.name, '乙');
    assert.equal(left.other.score, 12);
    assert.equal(left.other.secret, null);
  });

  it('乙的屏幕上分数 12、暗格 17；甲的分数 8、暗格空', () => {
    const { screens } = canonicalScreens();
    const right = screens.layout.right;
    assert.equal(right.position, 'right');
    assert.equal(right.own.name, '乙');
    assert.equal(right.own.score, 12);
    assert.equal(right.own.secret, 17);
    assert.equal(right.other.name, '甲');
    assert.equal(right.other.score, 8);
    assert.equal(right.other.secret, null);
  });

  it('公共屏只有 8 和 12，没有暗格栏', () => {
    const { screens } = canonicalScreens();
    assert.equal(screens.layout.top.packetLength, 26);
    assert.deepEqual(
      screens.layout.top.cells.map((cell) => [cell.name, cell.score, cell.secret]),
      [['甲', 8, null], ['乙', 12, null]],
    );
  });

  it('屏幕长度就是包长：30 / 30', () => {
    const { screens } = canonicalScreens();
    assert.equal(screens.layout.left.packetLength, 30);
    assert.equal(screens.layout.right.packetLength, 30);
  });

  it('drawScreenFromPacket 对泄流包直接拒绝', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const leak = {
      kind: 'leak' as const,
      recipient: 'public' as const,
      roomTag: 0,
      records: packets.public.decoded.records,
      secrets: [41, 17] as [number, number],
    };
    assert.throws(() => drawScreenFromPacket(leak, 34), (error) => code(error) === REJECT.LEAK_DETECTED);
  });
});

describe('screen/secret cross-leak', () => {
  it('左边画出 17，退回', () => {
    const { screens } = canonicalScreens();
    const broken = structuredClone(screens) as Screens;
    (broken.byOwner['甲'] as PlayerScreen).own.secret = 17;
    assert.throws(() => assertScreenValues(CANONICAL_ROOM, broken), (error) => code(error) === REJECT.SCREEN_PACKET_MISMATCH);
  });

  it('右边画出 41，退回', () => {
    const { screens } = canonicalScreens();
    const broken = structuredClone(screens) as Screens;
    (broken.byOwner['乙'] as PlayerScreen).own.secret = 41;
    assert.throws(() => assertScreenValues(CANONICAL_ROOM, broken), (error) => code(error) === REJECT.SCREEN_PACKET_MISMATCH);
  });

  it('上方画出 41 或 17，退回', () => {
    for (const secret of [41, 17]) {
      const { screens } = canonicalScreens();
      const broken = structuredClone(screens) as Screens;
      (broken.public as PublicScreen).cells[0].secret = secret;
      assert.throws(() => assertScreenValues(CANONICAL_ROOM, broken), (error) => code(error) === REJECT.PUBLIC_SCREEN_HAS_SECRET);
    }
  });

  it('乙的屏幕上读到 41，退回', () => {
    const { screens } = canonicalScreens();
    const broken = structuredClone(screens) as Screens;
    (broken.byOwner['甲'] as PlayerScreen).other.secret = 17 as unknown as null;
    assert.throws(() => assertScreenValues(CANONICAL_ROOM, broken), (error) => code(error) === REJECT.OTHER_SECRET_VISIBLE);
  });
});

describe('screen cannot drift from its packet', () => {
  it('只改甲的屏幕、包里仍是 17，退回', () => {
    // 甲's packet was built with 17 (a stale/wrong build); the screen paints 41.
    const canonical = createRoomPackets(CANONICAL_ROOM);
    const stalePackets = {
      public: canonical.public,
      byOwner: {
        甲: { ...canonical.byOwner['甲'], bytes: encodePrivateFrame(0, RECORDS, '甲', 17), decoded: decodeFrame(encodePrivateFrame(0, RECORDS, '甲', 17)) },
        乙: canonical.byOwner['乙'],
      },
    };
    const screens = structuredClone(renderScreens(CANONICAL_ROOM, canonical)) as Screens;
    (screens.byOwner['甲'] as PlayerScreen).own.secret = 41;

    assert.throws(
      () => assertScreensMatchPackets(CANONICAL_ROOM, screens, stalePackets),
      (error) => code(error) === REJECT.SCREEN_PACKET_MISMATCH,
    );
    // And the packet itself must still be rejected as a stand-in for 甲.
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, stalePackets.byOwner['甲'].decoded, '甲'),
      (error) => code(error) === REJECT.SWAPPED_SECRET,
    );
  });

  it('改了甲的暗格之后，乙的屏幕仍是 17', () => {
    const changed = createRoomPackets({ ...CANONICAL_ROOM, secrets: [42, 17] });
    const screens = renderScreens({ ...CANONICAL_ROOM, secrets: [42, 17] }, changed);
    assert.equal(screens.layout.left.own.secret, 42);
    assert.equal(screens.layout.right.own.secret, 17);
    assert.equal(screens.layout.right.other.secret, null);
    assert.equal(screens.layout.top.packetLength, 26);
    assert.equal(screens.layout.top.cells.every((cell) => cell.secret === null), true);
  });
});

describe('preview layout', () => {
  it('公共屏在上，甲在左，乙在右', () => {
    const { screens } = canonicalScreens();
    assertPreviewLayout(CANONICAL_ROOM, screens);
    assert.equal(screens.layout.top.position, 'top');
    assert.equal(screens.layout.left.owner, '甲');
    assert.equal(screens.layout.right.owner, '乙');
    assert.deepEqual(
      [screens.layout.left.own.secret, screens.layout.right.own.secret],
      [41, 17],
    );
  });

  it('甲乙对调，退回', () => {
    const { screens } = canonicalScreens();
    const broken = structuredClone(screens) as Screens;
    broken.layout.left = screens.layout.right;
    broken.layout.right = screens.layout.left;
    assert.throws(() => assertPreviewLayout(CANONICAL_ROOM, broken), (error) => code(error) === REJECT.WRONG_LAYOUT);
  });
});

describe('receive gate', () => {
  it('乙的端点收到写着 41 的包就退回', () => {
    const bundles = fanOut(CANONICAL_ROOM, createRoomPackets(CANONICAL_ROOM));
    const yi = bundles.find((bundle) => bundle.recipient === '乙')!;
    const forged = structuredClone(yi);
    // Swap in the 甲 packet while keeping 乙 as the recipient.
    forged.packets = [createRoomPackets(CANONICAL_ROOM).byOwner['甲']];
    assert.throws(
      () => receiveBundle(CANONICAL_ROOM, forged, '乙'),
      (error) => code(error) === REJECT.WRONG_OWNER,
    );
  });

  it('公共端点收到 30 字节的包就退回', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const bundle = { recipient: 'public', packets: [packets.byOwner['甲']] };
    assert.throws(
      () => receiveBundle(CANONICAL_ROOM, bundle, 'public'),
      (error) => code(error) === REJECT.PUBLIC_NOT_PUBLIC,
    );
  });

  it('正常的包通过接收', () => {
    const bundles = fanOut(CANONICAL_ROOM, createRoomPackets(CANONICAL_ROOM));
    for (const recipient of ['public', '甲', '乙']) {
      const bundle = bundles.find((entry) => entry.recipient === recipient)!;
      const received = receiveBundle(CANONICAL_ROOM, bundle, recipient);
      assert.equal(received.recipient, recipient);
    }
  });
});

describe('inspect room: packets first, then screens', () => {
  it('先报三包长度与暗格，再报三屏', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const screens = renderScreens(CANONICAL_ROOM, packets);
    const report = inspectRoom(CANONICAL_ROOM, packets, screens);

    assert.deepEqual(report.packets.map((packet) => packet.length), [26, 30, 30]);
    assert.deepEqual(report.packets.map((packet) => packet.secret), [null, 41, 17]);
    assert.deepEqual(report.packets[0].scores, [8, 12]);

    assert.equal(report.screens.top.length, 26);
    assert.equal(report.screens.left.own.secret, 41);
    assert.equal(report.screens.right.own.secret, 17);
    assert.equal(report.screens.left.other.secret, null);
    assert.equal(report.screens.right.other.secret, null);
  });

  it('只报一个 30、不报暗格，分不出甲乙，退回', () => {
    // Two 30-byte packets where one report omits its secret: length alone is
    // not enough to tell 甲's packet from 乙's.
    const packets = createRoomPackets(CANONICAL_ROOM);
    const screens = renderScreens(CANONICAL_ROOM, packets);
    const reports = [
      { length: 26, secret: null, recipient: 'public', scores: [8, 12] },
      { length: 30, secret: 41, recipient: '甲', scores: [8, 12] },
      { length: 30, secret: null, recipient: '乙', scores: [8, 12] },
    ];
    assert.throws(
      () => assertInspectionDistinguishesOwners(reports),
      (error) => code(error) === REJECT.AMBIGUOUS_INSPECTION,
    );
    // The real room passes.
    const inspected = inspectRoom(CANONICAL_ROOM, packets, screens);
    assert.deepEqual(inspected.packets.map((report) => report.secret), [null, 41, 17]);
  });

  it('两包都写成 41，分不出甲乙，退回', () => {
    const reports = [
      { length: 26, secret: null, recipient: 'public', scores: [8, 12] },
      { length: 30, secret: 41, recipient: '甲', scores: [8, 12] },
      { length: 30, secret: 41, recipient: '乙', scores: [8, 12] },
    ];
    assert.throws(
      () => assertInspectionDistinguishesOwners(reports),
      (error) => code(error) === REJECT.AMBIGUOUS_INSPECTION,
    );
  });

  it('第三包是 34 字节，说明两格暗格被塞进同一个人的包，退回', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const screens = renderScreens(CANONICAL_ROOM, packets);

    const leakBytes = encodeLeakFrame(0, RECORDS, [41, 17]);
    const broken = structuredClone(packets);
    broken.all[2] = {
      recipient: '乙',
      kind: 'private',
      bytes: leakBytes,
      length: leakBytes.byteLength,
      decoded: decodeFrame(leakBytes),
    };
    broken.byOwner['乙'] = broken.all[2];

    assert.equal(leakBytes.byteLength, 34);
    assert.throws(
      () => inspectRoom(CANONICAL_ROOM, broken, screens),
      (error) => code(error) === REJECT.BOTH_SECRETS_IN_ONE || code(error) === REJECT.PRIVATE_LENGTH,
    );
  });
});
