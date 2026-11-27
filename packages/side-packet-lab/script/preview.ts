/**
 * Writes the preview to disk and prints the packet table the operator reads
 * first when opening the room.
 *
 *     node script/preview.ts [out.html]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_ROOM,
  buildDelivery,
  inspectRoom,
  renderPreview,
} from '../src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(__dirname, '..', process.argv[2] ?? 'preview.html');

const delivery = buildDelivery(CANONICAL_ROOM);
const inspection = inspectRoom(CANONICAL_ROOM, delivery.packets, delivery.screens);
const preview = renderPreview(CANONICAL_ROOM, delivery.packets);

fs.writeFileSync(outFile, preview.html, 'utf8');

console.log('\n三包（先看包）：');
for (const packet of inspection.packets) {
  const secret = packet.secret === null ? '无暗格' : `暗格 ${packet.secret}`;
  console.log(`  ${String(packet.length).padStart(2)} 字节  ${packet.recipient.padEnd(6)}  分数 ${packet.scores.join(' / ')}  ${secret}`);
}

console.log('\n三屏（后看屏幕）：');
console.log(`  上   ${inspection.screens.top.length} 字节  分数 ${inspection.screens.top.scores.join(' / ')}  无暗格`);
console.log(
  `  左甲 ${inspection.screens.left.length} 字节  分数 ${inspection.screens.left.own.score} 暗格 ${inspection.screens.left.own.secret}` +
  `  乙的暗格：空`,
);
console.log(
  `  右乙 ${inspection.screens.right.length} 字节  分数 ${inspection.screens.right.own.score} 暗格 ${inspection.screens.right.own.secret}` +
  `  甲的暗格：空`,
);

console.log('\n每人的包：');
for (const bundle of delivery.bundles) {
  console.log(`  ${bundle.recipient.padEnd(6)} → ${bundle.packets.map((p) => `${p.length}B ${p.kind}`).join(', ')}`);
}

console.log(`\n预览已写入 ${outFile}`);
