import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasBoard } from "./components/CanvasBoard";
import type { Stroke } from "./types";
import { GatewayClient } from "./ws/gatewayClient";
import "./App.css";

const defaultWsUrl = "ws://localhost:8787/ws";

function mergeCommitted(prev: Stroke[], incoming: Stroke): Stroke[] {
  const without = prev.filter((s) => s.strokeId !== incoming.strokeId);
  return [...without, incoming].sort(
    (a, b) => (a.commitIndex ?? 0) - (b.commitIndex ?? 0),
  );
}

function applySnapshot(strokes: Stroke[]): Stroke[] {
  return [...strokes].sort((a, b) => (a.commitIndex ?? 0) - (b.commitIndex ?? 0));
}

export default function App() {
  const [wsUrl, setWsUrl] = useState(() => import.meta.env.VITE_WS_URL || defaultWsUrl);
  const [committed, setCommitted] = useState<Stroke[]>([]);
  const [status, setStatus] = useState<"offline" | "connecting" | "live">("offline");
  const [clientId, setClientId] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState(0);
  const clientRef = useRef<GatewayClient | null>(null);
  const optimisticSeq = useRef(0);

  const urlInputId = useMemo(() => "ws-url", []);

  useEffect(() => {
    const client = new GatewayClient(wsUrl, {
      onOpen: () => setStatus("connecting"),
      onWelcome: (id, idx) => {
        setClientId(id);
        setLastCommit(idx);
        setStatus("live");
      },
      onClose: () => {
        setStatus("offline");
        setClientId(null);
      },
      onStrokeCommitted: (stroke) => {
        setCommitted((p) => mergeCommitted(p, stroke));
        setLastCommit(stroke.commitIndex ?? 0);
        clientRef.current?.setLastSeenCommitIndex(stroke.commitIndex ?? 0);
      },
      onSnapshot: (strokes, idx) => {
        setCommitted(applySnapshot(strokes));
        setLastCommit(idx);
        clientRef.current?.setLastSeenCommitIndex(idx);
      },
      onError: (_code, msg) => {
        console.warn("gateway error", msg);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => client.disconnect();
  }, [wsUrl]);

  const onStrokeComplete = useCallback((stroke: Omit<Stroke, "commitIndex" | "authorClientId">) => {
    optimisticSeq.current += 1;
    const optimistic: Stroke = {
      ...stroke,
      authorClientId: clientRef.current?.assignedClientId ?? undefined,
      commitIndex: 1_000_000_000 + optimisticSeq.current,
    };
    setCommitted((p) => mergeCommitted(p, optimistic));
    clientRef.current?.sendStrokeAppend(stroke);
  }, []);

  const reconnect = () => {
    clientRef.current?.disconnect();
    clientRef.current?.connect();
  };

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
        <div className={`status status-${status}`}>
          {status === "live" && (
            <>
              Live · commit #{lastCommit}
            </>
          )}
          {status === "connecting" && <>Connecting…</>}
          {status === "offline" && <>Offline</>}
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
