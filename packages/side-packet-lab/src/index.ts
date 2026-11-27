/**
 * Public entry point.
 *
 * Typical use:
 *
 *     const packets = createRoomPackets(CANONICAL_ROOM, 'split-on-send');
 *     const bundles = fanOut(CANONICAL_ROOM, packets);
 *     const screens = renderScreens(CANONICAL_ROOM, packets);
 *     inspectRoom(CANONICAL_ROOM, packets, screens);   // throws on any violation
 *
 * Changing a secret:
 *
 *     const next = { ...CANONICAL_ROOM, secrets: [42, 17] as const };
 *     const packets = createRoomPackets(next);
 *     // 甲's packet bytes change; 乙's packet bytes and the 26-byte public
 *     // packet are byte-identical to the previous tick.
 */

export * from './protocol.ts';
export * from './codec.ts';
export * from './validate.ts';
export * from './room.ts';
export * from './screens.ts';
export * from './inspect.ts';
export * from './delivery.ts';
export * from './preview.ts';
