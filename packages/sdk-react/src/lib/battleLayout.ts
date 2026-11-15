/**
 * The battle split screen, as a self-contained compositor LAYER: a pure
 * layout (battleTiles) plus one draw call (drawBattleLayer) that takes the
 * canvas, its size and what to put in each half. The studio calls it in place
 * of its scene while a battle is on air; an overlay/layer list can call it
 * the same way, as one entry.
 *
 * Each studio puts ITSELF in the "self" tile and the other host in the
 * "other" tile. The other host's picture is cut out of THEIR published
 * program: they put themselves in their own self tile, and since the layout
 * is a pure function of the frame size, we know exactly where that is in
 * their frame from its dimensions alone. So nothing extra is published, no
 * server transcodes, and their half of OUR frame never feeds back into
 * theirs (no hall of mirrors).
 */

export interface BattleRect { x: number; y: number; w: number; h: number }

export interface BattleTiles {
  self: BattleRect;
  other: BattleRect;
  /** The divider between the two tiles. */
  divider: BattleRect;
}

/** Landscape: two halves, full height. Portrait: two 9:16 tiles side by side
 *  in the middle band (two full-height slivers would show nobody). */
export function battleTiles(W: number, H: number): BattleTiles {
  const gap = Math.max(2, Math.round(Math.max(W, H) * 0.004));
  const tileW = Math.max(0, Math.floor((W - gap) / 2));
  if (W >= H) {
    return {
      self: { x: 0, y: 0, w: tileW, h: H },
      other: { x: W - tileW, y: 0, w: tileW, h: H },
      divider: { x: tileW, y: 0, w: W - 2 * tileW, h: H },
    };
  }
  const tileH = Math.min(H, Math.round(tileW * 16 / 9));
  const y = Math.round((H - tileH) / 2);
  return {
    self: { x: 0, y, w: tileW, h: tileH },
    other: { x: W - tileW, y, w: tileW, h: tileH },
    divider: { x: tileW, y, w: W - 2 * tileW, h: tileH },
  };
}

/** The rectangle to sample from a source of `srcW x srcH` so that it covers
 *  a `dstW x dstH` box (centre crop). */
export function coverCrop(src: BattleRect, dstW: number, dstH: number): BattleRect {
  if (src.w <= 0 || src.h <= 0 || dstW <= 0 || dstH <= 0) return src;
  const srcAr = src.w / src.h;
  const dstAr = dstW / dstH;
  if (srcAr > dstAr) {
    const w = src.h * dstAr;
    return { x: src.x + (src.w - w) / 2, y: src.y, w, h: src.h };
  }
  const h = src.w / dstAr;
  return { x: src.x, y: src.y + (src.h - h) / 2, w: src.w, h };
}

/** Where the other host is in THEIR program frame: their own self tile. */
export function opponentSourceRect(videoW: number, videoH: number): BattleRect {
  return battleTiles(videoW, videoH).self;
}

export interface BattleVideoSource {
  videoWidth: number;
  videoHeight: number;
  readyState?: number;
}

export interface BattleLayerOptions {
  W: number;
  H: number;
  /** Draw this studio's own picture (camera, or its source) into the tile. */
  drawSelf: (r: BattleRect) => void;
  /** The other studio's program video, or null while it connects. */
  opponent: (CanvasImageSource & BattleVideoSource) | null;
  /** Shown on our own tile; the other side's name rides in with their crop. */
  selfName?: string;
  /** Shown in the other tile while their picture isn't there yet. */
  waitingText: string;
  dividerColor?: string;
}

function videoReady(v: BattleVideoSource | null): boolean {
  return !!v && (v.readyState === undefined || v.readyState >= 2) && v.videoWidth > 0 && v.videoHeight > 0;
}

function drawChip(ctx: CanvasRenderingContext2D, text: string, r: BattleRect): void {
  const size = Math.max(12, Math.round(Math.min(r.w, r.h) * 0.045));
  ctx.save();
  ctx.font = `600 ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const padX = Math.round(size * 0.6);
  const w = Math.min(r.w - 16, ctx.measureText(text).width + padX * 2);
  const h = Math.round(size * 1.7);
  const x = r.x + 10;
  const y = r.y + r.h - h - 10;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, h / 2);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2, w - padX * 2);
  ctx.restore();
}

function drawWaiting(ctx: CanvasRenderingContext2D, text: string, r: BattleRect): void {
  ctx.save();
  ctx.fillStyle = '#16161d';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const size = Math.max(12, Math.round(Math.min(r.w, r.h) * 0.05));
  ctx.font = `500 ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2, r.w - 24);
  ctx.restore();
}

/** Draw the battle split screen over the whole canvas. */
export function drawBattleLayer(ctx: CanvasRenderingContext2D, o: BattleLayerOptions): BattleTiles {
  const tiles = battleTiles(o.W, o.H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(tiles.self.x, tiles.self.y, tiles.self.w, tiles.self.h);
  ctx.clip();
  o.drawSelf(tiles.self);
  ctx.restore();
  if (o.selfName) drawChip(ctx, `@${o.selfName}`, tiles.self);

  const v = o.opponent;
  if (v && videoReady(v)) {
    const src = coverCrop(opponentSourceRect(v.videoWidth, v.videoHeight), tiles.other.w, tiles.other.h);
    ctx.drawImage(v, src.x, src.y, src.w, src.h, tiles.other.x, tiles.other.y, tiles.other.w, tiles.other.h);
  } else {
    drawWaiting(ctx, o.waitingText, tiles.other);
  }

  ctx.fillStyle = o.dividerColor ?? '#2c2c3a';
  ctx.fillRect(tiles.divider.x, tiles.divider.y, tiles.divider.w, tiles.divider.h);
  return tiles;
}
