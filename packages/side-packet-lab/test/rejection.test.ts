import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANONICAL_ROOM,
  REJECT,
  createRoomPackets,
  decodeFrame,
  encodeLeakFrame,
  encodePrivateFrame,
  encodePublicFrame,
  validateForRecipient,
  type RoomConfig,
} from '../src/index.ts';

const RECORDS = [
  { name: '甲', score: 8 },
  { name: '乙', score: 12 },
];

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe('decoder rejects malformed frames', () => {
  it('34 字节的包退回', () => {
    const leak = encodeLeakFrame(0, RECORDS, [41, 17]);
    const parsed = decodeFrame(leak);
    assert.equal(parsed.kind, 'leak');
    assert.deepEqual(parsed.secrets, [41, 17]);

    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, parsed, '甲'),
      (error) => code(error) === REJECT.BOTH_SECRETS_IN_ONE,
    );
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, parsed, '乙'),
      (error) => code(error) === REJECT.BOTH_SECRETS_IN_ONE,
    );
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, parsed, 'public'),
      (error) => code(error) === REJECT.BOTH_SECRETS_IN_ONE,
    );
  });

  it('公共包变成 30 字节、漏出一份暗格，退回', () => {
    // A frame declaring kind=public but carrying a secret slot.
    const publicBytes = encodePublicFrame(0, RECORDS);
    const smuggled = new Uint8Array(publicBytes.length + 4);
    smuggled.set(publicBytes);
    new DataView(smuggled.buffer).setInt32(publicBytes.length, 41, true);

    assert.throws(() => decodeFrame(smuggled), (error) => code(error) === REJECT.PUBLIC_LENGTH);
  });

  it('公共包读到 41 或 17，退回', () => {
    for (const secret of [41, 17]) {
      const bytes = encodePrivateFrame(0, RECORDS, '甲', secret);
      // Re-label it as public without removing the secret bytes.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint8(2, 0); // kind = public
      assert.throws(() => decodeFrame(bytes), (error) => code(error) === REJECT.PUBLIC_LENGTH);
    }
  });

  it('私有包同时带两个暗格，退回', () => {
    const leak = encodeLeakFrame(0, RECORDS, [41, 17]);
    const view = new DataView(leak.buffer, leak.byteOffset, leak.byteLength);
    view.setUint8(2, 1); // claim to be private
    view.setUint8(3, 0);
    assert.throws(() => decodeFrame(leak), (error) => code(error) === REJECT.BOTH_SECRETS_IN_ONE);
  });

  it('私有包缺暗格，退回', () => {
    const publicBytes = encodePublicFrame(0, RECORDS);
    const view = new DataView(publicBytes.buffer, publicBytes.byteOffset, publicBytes.byteLength);
    view.setUint8(2, 1);
    view.setUint8(3, 0);
    assert.throws(() => decodeFrame(publicBytes), (error) => code(error) === REJECT.PRIVATE_LENGTH);
  });
});

describe('semantic validation', () => {
  it('乙这边读到 41，退回', () => {
    const wrong = decodeFrame(encodePrivateFrame(0, RECORDS, '乙', 41));
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, wrong, '乙'),
      (error) => code(error) === REJECT.SWAPPED_SECRET,
    );
  });

  it('甲这包读到 17，退回', () => {
    const wrong = decodeFrame(encodePrivateFrame(0, RECORDS, '甲', 17));
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, wrong, '甲'),
      (error) => code(error) === REJECT.SWAPPED_SECRET,
    );
  });

  it('两包都写成 41 或都写成 17，退回', () => {
    for (const secret of [41, 17]) {
      const bytes = encodePrivateFrame(0, RECORDS, '甲', secret);
      assert.throws(() => {
        const config: RoomConfig = { ...CANONICAL_ROOM, secrets: [secret, secret] };
        validateForRecipient(config, decodeFrame(bytes), '甲');
      }, (error) => code(error) === REJECT.BOTH_SECRETS_IN_ONE);
    }
  });

  it('甲的主人标记配乙的暗格，退回', () => {
    const frame = decodeFrame(encodePrivateFrame(0, RECORDS, '甲', 17));
    assert.equal(frame.kind, 'private');
    assert.equal((frame as { owner: string }).owner, '甲');
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, frame, '乙'),
      (error) => code(error) === REJECT.WRONG_OWNER,
    );
  });

  it('41 被收成 40，退回', () => {
    const rounded = decodeFrame(encodePrivateFrame(0, RECORDS, '甲', 40));
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, rounded, '甲'),
      (error) => code(error) === REJECT.WRONG_SECRET,
    );
  });

  it('17 被收成 16，退回', () => {
    const rounded = decodeFrame(encodePrivateFrame(0, RECORDS, '乙', 16));
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, rounded, '乙'),
      (error) => code(error) === REJECT.WRONG_SECRET,
    );
  });

  it('非整数的暗格在编码前就退回', () => {
    assert.throws(
      () => encodePrivateFrame(0, RECORDS, '甲', 41.5),
      (error) => code(error) === REJECT.NON_INTEGER,
    );
    assert.throws(
      () => validateForRecipient({ ...CANONICAL_ROOM, secrets: [41.5, 17] }, decodeFrame(encodePrivateFrame(0, RECORDS, '甲', 41)), '甲'),
      (error) => code(error) === REJECT.NON_INTEGER,
    );
  });

  it('名字换成别的，26 / 30 对不上，退回', () => {
    const config: RoomConfig = { players: ['张三', '李四'], scores: [8, 12], secrets: [41, 17] };
    assert.throws(
      () => validateForRecipient(config, decodeFrame(encodePublicFrame(0, RECORDS)), 'public'),
      (error) => code(error) === REJECT.BAD_NAME,
    );
  });

  it('分数被改掉，退回', () => {
    const frame = decodeFrame(encodePrivateFrame(0, [{ name: '甲', score: 7 }, { name: '乙', score: 12 }], '甲', 41));
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, frame, '甲'),
      (error) => code(error) === REJECT.WRONG_SCORE,
    );
  });

  it('第三个人的视角不在核对范围，退回', () => {
    const frame = decodeFrame(encodePublicFrame(0, RECORDS));
    assert.throws(
      () => validateForRecipient(CANONICAL_ROOM, frame, '丙'),
      (error) => code(error) === REJECT.THIRD_PERSON,
    );
  });

  it('一个健康的房间通过全部校验', () => {
    const packets = createRoomPackets(CANONICAL_ROOM);
    validateForRecipient(CANONICAL_ROOM, packets.public.decoded, 'public');
    validateForRecipient(CANONICAL_ROOM, packets.byOwner['甲'].decoded, '甲');
    validateForRecipient(CANONICAL_ROOM, packets.byOwner['乙'].decoded, '乙');
  });
});
