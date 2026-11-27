# side-packet-lab

三包、两块屏幕、一屏公共。这个包把“公共 26 字节、甲乙各 30 字节”的契约实现成可以跑的代码和测试，不依赖房间框架：`node --test` 就能验证。

## 契约

字节布局（小端，所有数字都是 int32）：

```
header (4)   magic | version | kind | flags
room tag (4) uint32，整个房间期间不变
record × 2   uint16 名字字节数 | 名字 UTF-8 | int32 分数
secret × N   int32（N = 0 / 1 / 2）
```

名字按 **UTF-8 字节数**计。甲、乙各 3 字节：

| 包 | 构成 | 长度 |
| --- | --- | --- |
| 公共 | 8 + (2+3+4) + (2+3+4) | **26** |
| 私有（甲或乙） | 公共 + int32 暗格 | **30** |
| 泄漏（两格暗格同包） | 26 + 4 + 4 | **34** |

暗格的 slot 在公共包里**物理不存在**——不是填 0、不是留空，而是根本没有那几个字节。所以“公共包里没有 41 和 17”是字节级事实。

换名字会改变总长度（名字字节数不同），26 / 30 就不成立了。这是有意的：契约只对甲、乙成立。

## 用法

```ts
import {
  CANONICAL_ROOM, createRoomPackets, fanOut,
  renderScreens, inspectRoom, receiveBundle,
} from './src/index.ts';

const packets = createRoomPackets(CANONICAL_ROOM);      // 三包：26 / 30 / 30
const bundles = fanOut(CANONICAL_ROOM, packets);        // 公共 → 公共屏；甲/乙 → 各自
const screens = renderScreens(CANONICAL_ROOM, packets); // 屏幕完全由包投影出来
inspectRoom(CANONICAL_ROOM, packets, screens);          // 先查包，再查屏；任何违规抛出 PacketRejected
```

`createRoomPackets` 支持两种投递策略，结果必须逐字节一致：

- `'split-on-send'`（默认）——编码器只拿到本人的暗格，私有包从生成起就只有一格。
- `'filter-on-receive'`——房间内部两份暗格都在，但按收件人投影时只取本人那一格，出房间前就已经剥掉对方的。

## 包

- `src/protocol.ts` —— 常量、长度公式、拒绝码
- `src/codec.ts` —— 字节级编解码；结构不对（34 字节冒充 30）在这里退回
- `src/validate.ts` —— 语义校验：名字、分数、整数暗格、不串格
- `src/room.ts` —— 三包、收件人分组、完整房间检查
- `src/screens.ts` —— 屏幕由包投影；屏幕/包一致性、跨格泄漏、预览布局
- `src/inspect.ts` —— 接收关与“先包后屏”的房间检查
- `src/preview.ts` —— 静态预览 HTML

## 跑

```bash
node --test test/*.test.ts     # 65 项
node script/preview.ts         # 打印三包三屏，写出 preview.html
```

预览固定：公共屏在上，甲在左、画 41，乙在右、画 17；两人另一格都是空的。
