import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANONICAL_ROOM,
  createRoomPackets,
  renderPreview,
} from '../src/index.ts';

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('preview', () => {
  it('公共屏在上，甲乙分在两边', () => {
    const { model } = renderPreview(CANONICAL_ROOM, createRoomPackets(CANONICAL_ROOM));
    assert.equal(model.publicScreen.length, 26);
    assert.deepEqual(model.publicScreen.scores, [
      { name: '甲', score: 8 },
      { name: '乙', score: 12 },
    ]);
    assert.equal(model.left.name, '甲');
    assert.equal(model.left.own.secret, 41);
    assert.equal(model.right.name, '乙');
    assert.equal(model.right.own.secret, 17);
  });

  it('上方的模型里没有暗格', () => {
    const { screens } = renderPreview(CANONICAL_ROOM, createRoomPackets(CANONICAL_ROOM));
    assert.equal(screens.layout.top.cells.every((cell) => cell.secret === null), true);
  });

  it('左边画出 41，右边画出 17', () => {
    const { screens } = renderPreview(CANONICAL_ROOM, createRoomPackets(CANONICAL_ROOM));
    assert.equal(screens.layout.left.own.secret, 41);
    assert.equal(screens.layout.right.own.secret, 17);
    assert.equal(screens.layout.left.other.secret, null);
    assert.equal(screens.layout.right.other.secret, null);
  });

  it('HTML 里左边不会把 41 画成 17，右边不会把 17 画成 41', () => {
    const { html } = renderPreview(CANONICAL_ROOM, createRoomPackets(CANONICAL_ROOM));
    // The public panel (between "公共屏（上）" and the next row) carries 8 and 12 only.
    const publicPanel = html.slice(html.indexOf('公共屏（上）'), html.indexOf('（左）'));
    assert.equal(count(publicPanel, '>41<'), 0, '公共屏上出现了 41');
    assert.equal(count(publicPanel, '>17<'), 0, '公共屏上出现了 17');
    assert.match(publicPanel, />8</);
    assert.match(publicPanel, />12</);

    const leftPanel = html.slice(html.indexOf('（左）'), html.indexOf('（右）'));
    assert.equal(count(leftPanel, '>41<'), 1, '左边应画出 41');
    assert.equal(count(leftPanel, '>17<'), 0, '左边画出了 17');

    const rightPanel = html.slice(html.indexOf('（右）'));
    assert.equal(count(rightPanel, '>17<'), 1, '右边应画出 17');
    assert.equal(count(rightPanel, '>41<'), 0, '右边画出了 41');
  });

  it('预览跟着甲暗格的改动一起变', () => {
    const next = { ...CANONICAL_ROOM, secrets: [42, 17] as const };
    const { model } = renderPreview(next, createRoomPackets(next));
    assert.equal(model.left.own.secret, 42);
    assert.equal(model.right.own.secret, 17);
    assert.equal(model.publicScreen.length, 26);
    assert.equal(model.right.length, 30);
  });

  it('HTML 是自足的一页，三包齐备的标注在', () => {
    const { html } = renderPreview(CANONICAL_ROOM, createRoomPackets(CANONICAL_ROOM));
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /26 · 30 · 30/);
    assert.match(html, /公共屏（上）/);
    assert.match(html, /甲（左）/);
    assert.match(html, /乙（右）/);
  });
});
