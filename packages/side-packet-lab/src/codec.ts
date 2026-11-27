/**
 * Byte-level codec for the three frames in the lab.
 *
 * No JSON, no msgpack: the size contract (26 / 30 / 34) is only meaningful if
 * the byte layout is fixed. Every field is read and written at a known offset,
 * and the secret slot is physically absent from a public frame — it is not
 * present-but-blanked, so "public frame has no 41 and no 17" holds at the byte
 * level.
 */

import {
  HEADER_BYTES,
  KIND,
  MAGIC,
  NAME_LENGTH_BYTES,
  indexForOwner,
  ownerForIndex,
  PUBLIC_RECIPIENT,
  RECORD_COUNT,
  REJECT,
  reject,
  ROOM_TAG_BYTES,
  SCORE_BYTES,
  SECRET_BYTES,
  VERSION,
  type FrameKind,
  type OwnerName,
  utf8Length,
} from './protocol.ts';

export interface PlayerRecord {
  name: string;
  score: number;
}

export interface PublicFrame {
  kind: 'public';
  recipient: typeof PUBLIC_RECIPIENT;
  roomTag: number;
  records: PlayerRecord[];
  secrets: [];
}

export interface PrivateFrame {
  kind: 'private';
  recipient: OwnerName;
  roomTag: number;
  owner: OwnerName;
  records: PlayerRecord[];
  secrets: [number];
}

export interface LeakFrame {
  kind: 'leak';
  recipient: typeof PUBLIC_RECIPIENT;
  roomTag: number;
  records: PlayerRecord[];
  secrets: [number, number];
}

export type ParsedFrame = PublicFrame | PrivateFrame | LeakFrame;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function assertInt32(value: number, label: string): number {
  if (!Number.isInteger(value)) {
    reject(REJECT.NON_INTEGER, `${label} 必须是整数，收到 ${value}`);
  }
  if (value < -0x80000000 || value > 0x7fffffff) {
    reject(REJECT.OUT_OF_RANGE, `${label} 超出 int32 范围：${value}`);
  }
  return value;
}

function writeInt32(view: DataView, offset: number, value: number, label: string): void {
  view.setInt32(offset, assertInt32(value, label), true);
}

function readInt32(view: DataView, offset: number): number {
  return view.getInt32(offset, true);
}

function writeRecord(view: DataView, offset: number, record: PlayerRecord): number {
  const nameBytes = textEncoder.encode(record.name);
  if (nameBytes.length > 0xffff) {
    reject(REJECT.BAD_NAME, `名字太长，放不进 uint16 长度：${record.name}`);
  }
  view.setUint16(offset, nameBytes.length, true);
  offset += NAME_LENGTH_BYTES;
  new Uint8Array(view.buffer, view.byteOffset + offset, nameBytes.length).set(nameBytes);
  offset += nameBytes.length;
  writeInt32(view, offset, record.score, `${record.name} 的分数`);
  return offset + SCORE_BYTES;
}

/** Bytes a single record occupies: uint16 length + UTF-8 name + int32 score. */
export function recordByteLength(record: PlayerRecord): number {
  return NAME_LENGTH_BYTES + utf8Length(record.name) + SCORE_BYTES;
}

function frameHeaderLength(records: readonly PlayerRecord[]): number {
  return HEADER_BYTES + ROOM_TAG_BYTES + records.reduce((sum, r) => sum + recordByteLength(r), 0);
}

function buildFrame(
  kind: FrameKind,
  flags: number,
  roomTag: number,
  records: readonly PlayerRecord[],
  secrets: readonly number[],
): Uint8Array {
  if (records.length !== RECORD_COUNT) {
    reject(REJECT.BAD_NAME, `一包必须正好带 ${RECORD_COUNT} 个分数，收到 ${records.length} 个`);
  }

  const total = frameHeaderLength(records) + secrets.length * SECRET_BYTES;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  view.setUint8(0, MAGIC);
  view.setUint8(1, VERSION);
  view.setUint8(2, kind);
  view.setUint8(3, flags);
  writeInt32(view, HEADER_BYTES, roomTag, '房间标记');

  let offset = HEADER_BYTES + ROOM_TAG_BYTES;
  for (const record of records) {
    offset = writeRecord(view, offset, record);
  }
  for (const secret of secrets) {
    writeInt32(view, offset, secret, '暗格');
    offset += SECRET_BYTES;
  }

  if (offset !== total) {
    reject(REJECT.BAD_LENGTH, `内部长度不一致：写了 ${offset}，应为 ${total}`);
  }
  return bytes;
}

/** The shared screen's frame: both scores, neither secret, 26 bytes. */
export function encodePublicFrame(roomTag: number, records: readonly PlayerRecord[]): Uint8Array {
  return buildFrame(KIND.PUBLIC, 0, roomTag, records, []);
}

/** A recipient's frame: both scores plus exactly its own secret, 30 bytes. */
export function encodePrivateFrame(
  roomTag: number,
  records: readonly PlayerRecord[],
  owner: string,
  secret: number,
): Uint8Array {
  const ownerIndex = indexForOwner(owner);
  if (ownerIndex === undefined) {
    reject(REJECT.WRONG_OWNER, `私有包的主人必须是甲或乙，收到 ${JSON.stringify(owner)}`);
  }
  return buildFrame(KIND.PRIVATE, ownerIndex, roomTag, records, [secret]);
}

/**
 * The bad frame from the lab: both secrets in one packet, 34 bytes. Exported
 * so tests and the preview can show it is rejected on arrival.
 */
export function encodeLeakFrame(
  roomTag: number,
  records: readonly PlayerRecord[],
  secrets: readonly number[],
): Uint8Array {
  return buildFrame(KIND.LEAK, 0b11, roomTag, records, secrets);
}

export interface RawFrameDiagnostics {
  totalLength: number;
  headerLength: number;
  trailingBytes: number;
  declaredKind: number;
  flags: number;
}

/** Read a frame's shape without trusting its contents. `null` if truncated. */
export function inspectRaw(bytes: Uint8Array): RawFrameDiagnostics | null {
  if (bytes.length < HEADER_BYTES + ROOM_TAG_BYTES) { return null; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = HEADER_BYTES + ROOM_TAG_BYTES;
  try {
    for (let i = 0; i < RECORD_COUNT; i++) {
      const nameLength = view.getUint16(offset, true);
      offset += NAME_LENGTH_BYTES;
      if (offset + nameLength + SCORE_BYTES > bytes.length) { return null; }
      offset += nameLength + SCORE_BYTES;
    }
    return {
      totalLength: bytes.length,
      headerLength: offset,
      trailingBytes: bytes.length - offset,
      declaredKind: view.getUint8(2),
      flags: view.getUint8(3),
    };
  } catch {
    return null;
  }
}

/**
 * Structural decode. Rejects malformed frames and frames whose trailing byte
 * count contradicts their declared kind — a 34-byte packet cannot hide behind
 * a private header. Semantic checks (which secret belongs to whom, canonical
 * names, scores) live in validate.ts so a recipient can inspect a frame
 * without mutating it.
 */
export function decodeFrame(bytes: Uint8Array): ParsedFrame {
  if (bytes.length < HEADER_BYTES + ROOM_TAG_BYTES) {
    reject(REJECT.BAD_LENGTH, `包比头部还短（${bytes.length} 字节）`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint8(0) !== MAGIC) {
    reject(REJECT.BAD_MAGIC, `magic 不对：0x${view.getUint8(0).toString(16)}`);
  }
  if (view.getUint8(1) !== VERSION) {
    reject(REJECT.BAD_VERSION, `版本不对：${view.getUint8(1)}`);
  }

  const kindCode = view.getUint8(2);
  const flags = view.getUint8(3);
  if (kindCode !== KIND.PUBLIC && kindCode !== KIND.PRIVATE && kindCode !== KIND.LEAK) {
    reject(REJECT.BAD_FLAGS, `未知的包类型：${kindCode}`);
  }
  const kind = kindCode as FrameKind;

  const roomTag = readInt32(view, HEADER_BYTES);

  const records: PlayerRecord[] = [];
  let offset = HEADER_BYTES + ROOM_TAG_BYTES;
  for (let i = 0; i < RECORD_COUNT; i++) {
    const nameLength = view.getUint16(offset, true);
    offset += NAME_LENGTH_BYTES;
    if (offset + nameLength + SCORE_BYTES > bytes.length) {
      reject(REJECT.BAD_LENGTH, `第 ${i + 1} 个名字越过了包尾`);
    }
    let name: string;
    try {
      name = textDecoder.decode(bytes.subarray(offset, offset + nameLength));
    } catch {
      reject(REJECT.BAD_NAME, `第 ${i + 1} 个名字不是合法 UTF-8`);
    }
    offset += nameLength;
    const score = readInt32(view, offset);
    offset += SCORE_BYTES;
    records.push({ name, score });
  }

  const trailingBytes = bytes.length - offset;
  const expectedTrailing = kind === KIND.PUBLIC ? 0 : kind === KIND.PRIVATE ? SECRET_BYTES : 2 * SECRET_BYTES;

  if (trailingBytes !== expectedTrailing) {
    if (kind === KIND.PUBLIC) {
      reject(
        REJECT.PUBLIC_LENGTH,
        `公共包是 ${bytes.length} 字节，应到 ${offset} 字节为止；多出 ${trailingBytes} 字节，` +
          '多出来的正是不该给公共屏幕的那一格',
      );
    }
    if (kind === KIND.PRIVATE) {
      if (trailingBytes > SECRET_BYTES) {
        reject(REJECT.BOTH_SECRETS_IN_ONE, `私有包带着 ${trailingBytes} 字节暗格（应为 ${SECRET_BYTES}），两个暗格被塞进了同一包`);
      }
      reject(REJECT.PRIVATE_LENGTH, `私有包带着 ${trailingBytes} 字节的暗格区（应为 ${SECRET_BYTES}）`);
    }
    reject(REJECT.BAD_LENGTH, `这一包声明 ${expectedTrailing} 字节暗格，实际 ${trailingBytes} 字节`);
  }

  if (kind === KIND.PUBLIC) {
    if (flags !== 0) {
      reject(REJECT.BAD_FLAGS, `公共包的 flags 必须为 0，收到 ${flags}`);
    }
    return { kind: 'public', recipient: PUBLIC_RECIPIENT, roomTag, records, secrets: [] };
  }

  if (kind === KIND.PRIVATE) {
    const owner = ownerForIndex(flags);
    if (owner === undefined) {
      reject(REJECT.WRONG_OWNER, `私有包的主人编号 ${flags} 不是甲(0) 或 乙(1)`);
    }
    const secret = readInt32(view, offset);
    return { kind: 'private', recipient: owner, roomTag, owner, records, secrets: [secret] };
  }

  if (flags !== 0b11) {
    reject(REJECT.BAD_FLAGS, `泄漏包的 flags 必须为 0b11，收到 0b${flags.toString(2)}`);
  }
  const first = readInt32(view, offset);
  const second = readInt32(view, offset + SECRET_BYTES);
  return { kind: 'leak', recipient: PUBLIC_RECIPIENT, roomTag, records, secrets: [first, second] };
}

/** Total byte length of a frame. */
export function frameLength(bytes: Uint8Array): number {
  return bytes.byteLength;
}
