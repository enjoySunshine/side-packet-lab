/**
 * End-to-end walkthrough of the acceptance narrative, in the order the lab
 * describes it: open the room → inspect the packets → inspect the screens →
 * change 甲's secret → re-inspect.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANONICAL_ROOM,
  REJECT,
  createRoomPackets,
  fanOut,
  inspectRoom,
  receiveBundle,
  renderScreens,
  type RoomConfig,
} from '../src/index.ts';

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe('walkthrough', () => {
  it('从甲这边核对：8 / 41，乙 12 / 空，包长 30', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const bundles = fanOut(CANONICAL_ROOM, packets);
    const jia = receiveBundle(CANONICAL_ROOM, bundles.find((b) => b.recipient === '甲')!, '甲');

    assert.equal(jia.packets.length, 1);
    assert.equal(jia.packets[0].length, 30);
    const frame = jia.packets[0].decoded;
    assert.equal(frame.kind, 'private');
    assert.deepEqual(frame.records, [{ name: '甲', score: 8 }, { name: '乙', score: 12 }]);
    assert.deepEqual(frame.secrets, [41]);
  });

  it('再看公共屏：包长 26，41 不在上面', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const bundles = fanOut(CANONICAL_ROOM, packets);
    const shared = receiveBundle(CANONICAL_ROOM, bundles.find((b) => b.recipient === 'public')!, 'public');

    assert.equal(shared.packets[0].length, 26);
    assert.deepEqual(shared.packets[0].decoded.records.map((r) => r.score), [8, 12]);
    assert.deepEqual(shared.packets[0].decoded.secrets, []);
    const screen = renderScreens(CANONICAL_ROOM, packets).layout.top;
    assert.deepEqual(screen.cells.map((c) => c.secret), [null, null]);
  });

  it('换到乙那边：17，甲 8 / 空，包也是 30', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const bundles = fanOut(CANONICAL_ROOM, packets);
    const yi = receiveBundle(CANONICAL_ROOM, bundles.find((b) => b.recipient === '乙')!, '乙');

    assert.equal(yi.packets[0].length, 30);
    assert.deepEqual(yi.packets[0].decoded.secrets, [17]);
    const screen = renderScreens(CANONICAL_ROOM, packets).layout.right;
    assert.deepEqual(screen.other, { name: '甲', score: 8, secret: null });
  });

  it('两包对调过来才对；现在就是对的', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    assert.deepEqual(
      [packets.byOwner['甲'].decoded.secrets[0], packets.byOwner['乙'].decoded.secrets[0]],
      [41, 17],
    );
    // Swapping them is rejected.
    assert.throws(
      () => receiveBundle(CANONICAL_ROOM, {
        recipient: '甲',
        packets: [createRoomPackets(CANONICAL_ROOM).byOwner['乙']],
      }, '甲'),
      (error) => code(error) === REJECT.WRONG_OWNER,
    );
  });

  it('打开房间：先包后屏，全部通过', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    const screens = renderScreens(CANONICAL_ROOM, packets);
    const report = inspectRoom(CANONICAL_ROOM, packets, screens);

    assert.deepEqual(report.packets.map((p) => p.length), [26, 30, 30]);
    assert.deepEqual(report.packets.map((p) => p.secret), [null, 41, 17]);
    assert.deepEqual(report.screens.top.scores, [8, 12]);
  });

  it('改了甲暗格：甲包变，乙包不变，公共包仍是 26 且无暗格', () => {
    const before = createRoomPackets(CANONICAL_ROOM);
    const next: RoomConfig = { ...CANONICAL_ROOM, secrets: [42, 17] };
    const after = createRoomPackets(next);

    assert.notDeepEqual(Buffer.from(before.byOwner['甲'].bytes), Buffer.from(after.byOwner['甲'].bytes));
    assert.deepEqual(Buffer.from(before.byOwner['乙'].bytes), Buffer.from(after.byOwner['乙'].bytes));
    assert.deepEqual(Buffer.from(before.public.bytes), Buffer.from(after.public.bytes));

    const report = inspectRoom(next, after, renderScreens(next, after));
    assert.deepEqual(report.packets.map((p) => p.secret), [null, 42, 17]);
  });

  it('只修屏幕、包里仍是 17，退回', () => {
    // 甲's packet carries 17 while the canonical screen shows 41: the packet
    // is rejected before the screen is ever consulted.
    const stale = createRoomPackets({ ...CANONICAL_ROOM, secrets: [17, 17] });
    assert.throws(
      () => inspectRoom(CANONICAL_ROOM, stale, renderScreens(CANONICAL_ROOM, createRoomPackets(CANONICAL_ROOM))),
      (error) => code(error) === REJECT.SWAPPED_SECRET || code(error) === REJECT.BOTH_SECRETS_IN_ONE,
    );
  });
});
