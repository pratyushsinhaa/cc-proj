export type Point = { x: number; y: number };

export type Stroke = {
  strokeId: string;
  color: string;
  width: number;
  points: Point[];
  authorClientId?: string;
  commitIndex?: number;
};

export type ClusterHint = {
  leaderId: string;
  term: number;
  role?: string;
};

export type ClusterTransition = {
  reason: string;
  leaderId: string;
  term: number;
  phase?: string;
};

export type ClientMessage =
  | { type: "hello"; lastSeenCommitIndex: number; protocolVersion: number }
  | {
      type: "stroke.append";
      strokeId: string;
      color: string;
      width: number;
      points: Point[];
    };

export type ServerMessage =
  | {
      type: "welcome";
      clientId: string;
      lastCommitIndex: number;
    }
  | {
      type: "stroke.committed";
      strokeId: string;
      color: string;
      width: number;
      points: Point[];
      authorClientId?: string;
      commitIndex: number;
    }
  | { type: "state.snapshot"; strokes: Stroke[]; lastCommitIndex: number }
  | { type: "cluster.hint"; leaderId: string; term: number; role?: string }
  | {
      type: "cluster.transition";
      reason: string;
      leaderId: string;
      term: number;
      phase?: string;
    }
  | { type: "error"; code: string; message: string };
