import { useCallback, useEffect, useRef, useState } from "react";
import type { Point, Stroke } from "../types";

function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  scale: number,
) {
  if (stroke.points.length === 0) return;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const p0 = stroke.points[0];
  ctx.moveTo(p0.x * scale, p0.y * scale);
  for (let i = 1; i < stroke.points.length; i++) {
    const p = stroke.points[i];
    ctx.lineTo(p.x * scale, p.y * scale);
  }
  ctx.stroke();
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function createStrokeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const rand = Math.random().toString(16).slice(2, 10);
  return `stroke-${Date.now()}-${rand}`;
}

type Props = {
  committedStrokes: Stroke[];
  onStrokeComplete: (stroke: Omit<Stroke, "commitIndex" | "authorClientId">) => void;
  remoteClientId?: string | null;
};

export function CanvasBoard({ committedStrokes, onStrokeComplete, remoteClientId }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState("#1a1a2e");
  const [width, setWidth] = useState(3);
  const activeRef = useRef<Omit<Stroke, "commitIndex" | "authorClientId"> | null>(null);
  const [, bump] = useState(0);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f8f9fc";
    ctx.fillRect(0, 0, w, h);
    const scale = 1;
    for (const s of committedStrokes) {
      drawStroke(ctx, s, scale);
    }
    const active = activeRef.current;
    if (active && active.points.length > 0) {
      drawStroke(ctx, active, scale);
    }
  }, [committedStrokes]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const ro = new ResizeObserver(() => redraw());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [redraw]);

  const pushPoint = (x: number, y: number) => {
    const active = activeRef.current;
    if (!active) return;
    const last = active.points[active.points.length - 1];
    const p = { x, y };
    if (last && distance(last, p) < 1.5) return;
    active.points.push(p);
    bump((n) => n + 1);
    requestAnimationFrame(redraw);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const el = canvasRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    activeRef.current = {
      strokeId: createStrokeId(),
      color,
      width,
      points: [{ x, y }],
    };
    bump((n) => n + 1);
    requestAnimationFrame(redraw);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!activeRef.current) return;
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    pushPoint(e.clientX - r.left, e.clientY - r.top);
  };

  const endStroke = () => {
    const active = activeRef.current;
    activeRef.current = null;
    if (active && active.points.length > 0) {
      onStrokeComplete(active);
    }
    requestAnimationFrame(redraw);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    endStroke();
  };

  return (
    <div className="canvas-shell">
      <aside className="toolbar">
        <label>
          Color
          <input type="color" value={color} onChange={(ev) => setColor(ev.target.value)} />
        </label>
        <label>
          Width {width}px
          <input
            type="range"
            min={1}
            max={24}
            value={width}
            onChange={(ev) => setWidth(Number(ev.target.value))}
          />
        </label>
        {remoteClientId && (
          <span className="client-badge" title="Gateway-assigned id">
            {remoteClientId}
          </span>
        )}
      </aside>
      <div ref={wrapRef} className="canvas-wrap">
        <canvas
          ref={canvasRef}
          className="draw-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
    </div>
  );
}
