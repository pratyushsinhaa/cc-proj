import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasBoard } from "./components/CanvasBoard";
import type { Stroke } from "./types";
import { GatewayClient } from "./ws/gatewayClient";
import "./App.css";

const defaultWsUrl = "ws://localhost:8080";

function mergeCommitted(prev: Stroke[], incoming: Stroke): Stroke[] {
  const without = prev.filter((s) => s.strokeId !== incoming.strokeId);
  return [...without, incoming].sort((a, b) => (a.commitIndex ?? 0) - (b.commitIndex ?? 0));
}

function applySnapshot(strokes: Stroke[]): Stroke[] {
  return [...strokes].sort((a, b) => (a.commitIndex ?? 0) - (b.commitIndex ?? 0));
}

type ConnStatus = "offline" | "connecting" | "reconnecting" | "syncing" | "live";

export default function App() {
  const [wsUrl, setWsUrl] = useState(() => import.meta.env.VITE_WS_URL || defaultWsUrl);
  const [committed, setCommitted] = useState<Stroke[]>([]);
  const [connStatus, setConnStatus] = useState<ConnStatus>("connecting");
  const [clientId, setClientId] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState(0);
  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [term, setTerm] = useState<number | null>(null);
  const [nextRetryMs, setNextRetryMs] = useState<number | null>(null);
  const [outboundQueued, setOutboundQueued] = useState(0);
  const [unackedCount, setUnackedCount] = useState(0);

  const clientRef = useRef<GatewayClient | null>(null);
  const optimisticSeq = useRef(0);
  /** Strokes we drew locally that may not appear in the server log yet (for resend after snapshot). */
  const localPendingRef = useRef<Map<string, Stroke>>(new Map());

  const urlInputId = useMemo(() => "ws-url", []);

  const reconcileSnapshot = useCallback((strokes: Stroke[], commitIndex: number) => {
    const serverIds = new Set(strokes.map((s) => s.strokeId));
    for (const id of localPendingRef.current.keys()) {
      if (serverIds.has(id)) {
        localPendingRef.current.delete(id);
      }
    }
    setUnackedCount(localPendingRef.current.size);

    const client = clientRef.current;
    if (client) {
      for (const [id, stroke] of localPendingRef.current) {
        if (!serverIds.has(id)) {
          client.sendStrokeAppend({
            strokeId: stroke.strokeId,
            color: stroke.color,
            width: stroke.width,
            points: stroke.points,
          });
        }
      }
    }

    setCommitted(applySnapshot(strokes));
    setLastCommit(commitIndex);
    clientRef.current?.setLastSeenCommitIndex(commitIndex);
  }, []);

  useEffect(() => {
    const client = new GatewayClient(wsUrl, {
      onOpen: () => {
        setConnStatus("connecting");
        setNextRetryMs(null);
      },
      onWelcome: (id, idx) => {
        setClientId(id);
        setLastCommit(idx);
        setConnStatus("live");
      },
      onClose: () => {
        setConnStatus("reconnecting");
      },
      onReconnecting: (delayMs) => {
        setNextRetryMs(delayMs);
        setConnStatus("reconnecting");
      },
      onStrokeCommitted: (stroke) => {
        localPendingRef.current.delete(stroke.strokeId);
        setUnackedCount(localPendingRef.current.size);
        setCommitted((p) => mergeCommitted(p, stroke));
        setLastCommit(stroke.commitIndex ?? 0);
        clientRef.current?.setLastSeenCommitIndex(stroke.commitIndex ?? 0);
      },
      onSnapshot: (strokes, idx) => {
        reconcileSnapshot(strokes, idx);
        setConnStatus((s) => (s === "syncing" ? "live" : s));
      },
      onClusterHint: (lid, t) => {
        setLeaderId(lid);
        setTerm(t);
      },
      onClusterTransition: (_reason, lid, t) => {
        setLeaderId(lid);
        setTerm(t);
        setConnStatus((s) => (s === "live" || s === "syncing" ? "syncing" : s));
      },
      onQueueChange: (n) => setOutboundQueued(n),
      onError: (_code, msg) => {
        console.warn("gateway error", msg);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => client.disconnect();
  }, [wsUrl, reconcileSnapshot]);

  const onStrokeComplete = useCallback((stroke: Omit<Stroke, "commitIndex" | "authorClientId">) => {
    optimisticSeq.current += 1;
    const full: Stroke = {
      ...stroke,
      authorClientId: clientRef.current?.assignedClientId ?? undefined,
      commitIndex: 1_000_000_000 + optimisticSeq.current,
    };
    localPendingRef.current.set(stroke.strokeId, full);
    setUnackedCount(localPendingRef.current.size);
    setCommitted((p) => mergeCommitted(p, full));
    clientRef.current?.sendStrokeAppend(stroke);
  }, []);

  const reconnect = () => {
    clientRef.current?.disconnect();
    clientRef.current?.connect();
  };

  const statusClass =
    connStatus === "live"
      ? "status-live"
      : connStatus === "connecting" || connStatus === "syncing"
        ? "status-connecting"
        : connStatus === "reconnecting"
          ? "status-reconnecting"
          : "status-offline";

  const statusLabel = (() => {
    if (connStatus === "live") {
      return (
        <>
          Live · commit #{lastCommit}
          {leaderId != null && term != null && (
            <span className="meta-hint">
              {" "}
              · leader {leaderId} · term {term}
            </span>
          )}
        </>
      );
    }
    if (connStatus === "syncing") return <>Syncing cluster…</>;
    if (connStatus === "connecting") return <>Connecting…</>;
    if (connStatus === "reconnecting")
      return (
        <>
          Reconnecting
          {nextRetryMs != null && (
            <span className="meta-hint"> · next try ~{Math.round(nextRetryMs / 100) / 10}s</span>
          )}
        </>
      );
    return <>Offline</>;
  })();

  return (
    <div className="app">
      <header className="top-bar">
        <h1>Shared canvas</h1>
        <div className="conn-controls">
          <label htmlFor={urlInputId}>WebSocket</label>
          <input
            id={urlInputId}
            className="ws-input"
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
          />
          <button type="button" className="btn" onClick={reconnect}>
            Reconnect
          </button>
        </div>
        <div className={`status ${statusClass}`}>{statusLabel}</div>
        <div className="metrics" title="Week 3: queue + unacked strokes">
          {outboundQueued > 0 && <span className="metric-warn">Queued sends: {outboundQueued}</span>}
          {unackedCount > 0 && <span className="metric-warn">Awaiting ack: {unackedCount}</span>}
          {outboundQueued === 0 && unackedCount === 0 && <span className="metric-ok">Transport idle</span>}
        </div>
      </header>
      <CanvasBoard
        committedStrokes={committed}
        onStrokeComplete={onStrokeComplete}
        remoteClientId={clientId}
      />
    </div>
  );
}
