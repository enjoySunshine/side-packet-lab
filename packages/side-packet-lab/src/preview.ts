/**
 * Static preview of the room, rendered from the same packets the checks use.
 *
 * Layout, fixed:
 *
 *     ┌──────────────────────────────┐
 *     │     公共屏（26 字节）          │   above
 *     │   甲 8      |      乙 12      │   scores only
 *     └──────────────────────────────┘
 *
 *     ┌──────────────┐  ┌──────────────┐
 *     │ 甲（左, 30） │  │ 乙（右, 30） │
 *     │ 8   41       │  │ 12  17       │
 *     │ 乙 12  ─     │  │ 甲 8   ─     │
 *     └──────────────┘  └────────────────┘
 *
 * The preview is a function of the packets, so a number that is not in a
 * packet cannot appear on its screen.
 */

import {
  CANONICAL_PUBLIC_LENGTH,
  CANONICAL_PRIVATE_LENGTH,
} from './protocol.ts';
import type { RoomConfig } from './validate.ts';
import type { RoomPackets } from './room.ts';
import { renderScreens, type Screens } from './screens.ts';

export interface PreviewModel {
  title: string;
  roomTag: number;
  publicScreen: { length: number; scores: Array<{ name: string; score: number }> };
  left: { name: string; length: number; own: { score: number; secret: number }; other: { name: string; score: number } };
  right: { name: string; length: number; own: { score: number; secret: number }; other: { name: string; score: number } };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildPreviewModel(config: RoomConfig, packets: RoomPackets, screens: Screens): PreviewModel {
  const left = screens.layout.left;
  const right = screens.layout.right;

  return {
    title: 'side-packet-lab',
    roomTag: packets.public.decoded.roomTag,
    publicScreen: {
      length: screens.public.packetLength,
      scores: screens.public.cells.map((cell) => ({ name: cell.name, score: cell.score })),
    },
    left: {
      name: '甲',
      length: left.packetLength,
      own: { score: left.own.score, secret: left.own.secret },
      other: { name: left.other.name, score: left.other.score },
    },
    right: {
      name: '乙',
      length: right.packetLength,
      own: { score: right.own.score, secret: right.own.secret },
      other: { name: right.other.name, score: right.other.score },
    },
  };
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Noto Sans SC", sans-serif;
         background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .room { max-width: 880px; margin: 0 auto; padding: 32px 20px 48px; }
  .title { font-size: 15px; letter-spacing: .08em; text-transform: uppercase; color: #94a3b8; }
  .tag { font-size: 12px; color: #64748b; margin-top: 4px; }
  .row { display: flex; gap: 20px; margin-top: 24px; }
  .row > * { flex: 1; }
  .panel { border: 1px solid #334155; border-radius: 12px; background: #111c33; padding: 16px; }
  .panel.public { border-color: #38bdf8; }
  .panel.left { border-color: #f472b6; }
  .panel.right { border-color: #34d399; }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between; }
  .who { font-size: 14px; font-weight: 600; }
  .len { font-size: 12px; color: #94a3b8; font-variant-numeric: tabular-nums; }
  .cells { display: flex; gap: 12px; margin-top: 14px; }
  .cell { flex: 1; border-radius: 8px; background: #0b1220; padding: 10px 12px; }
  .cell .k { font-size: 11px; color: #64748b; }
  .cell .v { font-size: 22px; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .cell.own .v.secret { color: #f8fafc; }
  .empty { color: #475569; font-size: 18px; }
  .note { margin-top: 28px; font-size: 12px; line-height: 1.7; color: #64748b; }
  .ok { color: #34d399; }
`;

export function renderPreviewHtml(model: PreviewModel): string {
  const publicCells = model.publicScreen.scores
    .map((cell) => `<div class="cell"><div class="k">${escapeHtml(cell.name)} 的分数</div><div class="v">${cell.score}</div></div>`)
    .join('');

  const privatePanel = (side: 'left' | 'right', data: PreviewModel['left'] | PreviewModel['right']) => `
    <div class="panel ${side}">
      <div class="panel-head">
        <span class="who">${escapeHtml(data.name)}（${side === 'left' ? '左' : '右'}）</span>
        <span class="len">${data.length} 字节</span>
      </div>
      <div class="cells">
        <div class="cell own">
          <div class="k">自己的分数 / 暗格</div>
          <div class="v">${data.own.score} <span class="v secret">${data.own.secret}</span></div>
        </div>
        <div class="cell">
          <div class="k">${escapeHtml(data.other.name)} 的分数 / 暗格</div>
          <div class="v">${data.other.score} <span class="empty">（空）</span></div>
        </div>
      </div>
    </div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)}</title>
<style>${STYLE}</style>
</head>
<body>
  <main class="room">
    <div class="title">${escapeHtml(model.title)}</div>
    <div class="tag">房间标记 ${model.roomTag} · 公共包 ${CANONICAL_PUBLIC_LENGTH} 字节 · 私有包 ${CANONICAL_PRIVATE_LENGTH} 字节</div>

    <div class="row">
      <div class="panel public">
        <div class="panel-head">
          <span class="who">公共屏（上）</span>
          <span class="len">${model.publicScreen.length} 字节</span>
        </div>
        <div class="cells">${publicCells}</div>
      </div>
    </div>

    <div class="row">
      ${privatePanel('left', model.left)}
      ${privatePanel('right', model.right)}
    </div>

    <p class="note">
      公共 26 字节里只有两个分数，没有暗格。<br>
      甲（左）30 字节，暗格 41；乙的暗格在他的屏幕上是空的。<br>
      乙（右）30 字节，暗格 17；甲的暗格在他的屏幕上是空的。<br>
      两包都是 30 字节，光看长度分不出谁拿了哪一个暗格。
    </p>
    <p class="note ok">三包齐备：26 · 30 · 30</p>
  </main>
</body>
</html>`;
}

/** Build the preview from packets, re-rendering the screens from those packets. */
export function renderPreview(config: RoomConfig, packets: RoomPackets): { model: PreviewModel; html: string; screens: Screens } {
  const screens = renderScreens(config, packets);
  const model = buildPreviewModel(config, packets, screens);
  return { model, html: renderPreviewHtml(model), screens };
}
