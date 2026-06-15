import { useRef, useEffect, useState, useCallback } from 'react';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { getStroke } from 'perfect-freehand';
import type { Stroke } from '../../hooks/useFastDraw.js';

interface DrawingCanvasProps {
  isDrawer: boolean;
  currentDrawer: string;
  strokeSnapshot: Stroke[];
  disabled?: boolean;
  onStrokeComplete?: (allStrokes: Stroke[]) => void;
}

const COLORS = ['#1a1a1a', '#e53e3e', '#3182ce', '#38a169', '#d69e2e'];
const ERASER_COLOR = '#ffffff';
const SIZES = [4, 8];

function renderStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, w: number, h: number) {
  const pts = stroke.points.map(([x, y]) => [x * w, y * h] as [number, number]);
  const outline = getStroke(pts, { size: stroke.width, smoothing: 0.5, thinning: 0.3 });
  if (!outline.length) return;
  ctx.beginPath();
  ctx.moveTo(outline[0]![0], outline[0]![1]);
  for (const pt of outline.slice(1)) ctx.lineTo(pt[0], pt[1]);
  ctx.closePath();
  ctx.fillStyle = stroke.color;
  ctx.fill();
}

function redrawAll(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  for (const s of strokes) renderStroke(ctx, s, w, h);
}

let strokeCounter = 0;

export function DrawingCanvas({ isDrawer, currentDrawer, strokeSnapshot, disabled = false, onStrokeComplete }: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { localParticipant } = useLocalParticipant();

  const [color, setColor] = useState('#1a1a1a');
  const [size, setSize] = useState(4);
  const [eraser, setEraser] = useState(false);

  const strokesRef = useRef<Stroke[]>([]);  // drawer: all completed strokes
  const currentPointsRef = useRef<[number, number][]>([]);
  const isPointerDown = useRef(false);

  // Receiver: strokes accumulated from data channel
  const receivedStrokesRef = useRef<Stroke[]>([]);

  const publish = useCallback((data: unknown) => {
    if (!localParticipant) return;
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    localParticipant.publishData(bytes, { topic: 'draw' });
  }, [localParticipant]);

  // Initialize canvas from snapshot (late joiner or remount)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (isDrawer) {
      strokesRef.current = [...strokeSnapshot];
    } else {
      receivedStrokesRef.current = [...strokeSnapshot];
    }
    redrawAll(ctx, strokeSnapshot, canvas.width, canvas.height);
  }, [strokeSnapshot, isDrawer]);

  // Receiver: listen to draw topic
  const onDrawMessage = useCallback((msg: { payload: Uint8Array; from?: Participant }) => {
    if (isDrawer) return;
    const senderId = msg.from?.identity ?? '';
    if (senderId !== currentDrawer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload)) as { type: string; stroke?: Stroke };
      if (data.type === 'draw_stroke' && data.stroke) {
        receivedStrokesRef.current.push(data.stroke);
        renderStroke(ctx, data.stroke, canvas.width, canvas.height);
      } else if (data.type === 'draw_clear') {
        receivedStrokesRef.current = [];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    } catch { /* ignore */ }
  }, [isDrawer, currentDrawer]);

  useDataChannel('draw', onDrawMessage);

  // Pointer handlers (drawer only)
  const getPos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const w = canvasRef.current!.width;
    const h = canvasRef.current!.height;
    return [(e.clientX - rect.left) / rect.width * (w / w), (e.clientY - rect.top) / rect.height * (h / h)];
    // normalized: divide by display size to get 0-1, but canvas internal res = 1:1 here
  };

  const getNormalizedPos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer || disabled) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    isPointerDown.current = true;
    currentPointsRef.current = [getNormalizedPos(e)];
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer || disabled || !isPointerDown.current) return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    currentPointsRef.current.push(getNormalizedPos(e));
    // Live preview: redraw all + current stroke in progress
    redrawAll(ctx, strokesRef.current, canvas.width, canvas.height);
    const preview: Stroke = {
      id: 'preview',
      points: currentPointsRef.current,
      color: eraser ? ERASER_COLOR : color,
      width: eraser ? size * 3 : size,
    };
    renderStroke(ctx, preview, canvas.width, canvas.height);
  };

  const handlePointerUp = () => {
    if (!isDrawer || disabled || !isPointerDown.current) return;
    isPointerDown.current = false;
    if (currentPointsRef.current.length === 0) return;

    const stroke: Stroke = {
      id: `s${++strokeCounter}-${Date.now()}`,
      points: currentPointsRef.current,
      color: eraser ? ERASER_COLOR : color,
      width: eraser ? size * 3 : size,
    };
    currentPointsRef.current = [];
    strokesRef.current.push(stroke);

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    redrawAll(ctx, strokesRef.current, canvas.width, canvas.height);

    publish({ type: 'draw_stroke', stroke });
    onStrokeComplete?.(strokesRef.current);
  };

  const handleClear = () => {
    if (!isDrawer) return;
    strokesRef.current = [];
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    publish({ type: 'draw_clear' });
    onStrokeComplete?.([]);
  };

  return (
    <div className="hh-fastdraw__canvas-wrap">
      <canvas
        ref={canvasRef}
        className="hh-fastdraw__canvas"
        width={600}
        height={450}
        style={{ cursor: disabled ? 'default' : isDrawer ? (eraser ? 'cell' : 'crosshair') : 'default' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      {isDrawer && !disabled && (
        <div className="hh-fastdraw__toolbar">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`hh-fastdraw__swatch${!eraser && color === c ? ' hh-fastdraw__swatch--active' : ''}`}
              style={{ background: c }}
              onClick={() => { setColor(c); setEraser(false); }}
              aria-label={`Color ${c}`}
            />
          ))}
          <button
            className={`hh-btn hh-btn--sm${eraser ? ' hh-btn--active' : ''}`}
            onClick={() => setEraser((v) => !v)}
          >
            Eraser
          </button>
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="hh-fastdraw__size-select"
          >
            {SIZES.map((s) => <option key={s} value={s}>{s === 4 ? 'Thin' : 'Thick'}</option>)}
          </select>
          <button className="hh-btn hh-btn--sm hh-btn--danger" onClick={handleClear}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
