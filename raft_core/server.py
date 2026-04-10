from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from .models import AppendEntriesRequest, LogEntry, VoteRequest
from .node import RaftNode


class RaftRPCHandler(BaseHTTPRequestHandler):
    node: RaftNode

    def _send_json(self, code: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        return json.loads(body)

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self._read_json()
            if self.path == "/raft/request-vote":
                request = VoteRequest(
                    term=int(payload["term"]),
                    candidate_id=str(payload["candidate_id"]),
                    last_log_index=int(payload["last_log_index"]),
                    last_log_term=int(payload["last_log_term"]),
                )
                result = self.node.handle_vote_request(request)
                self._send_json(200, {"term": result.term, "vote_granted": result.vote_granted, "reason": result.reason})
                return

            if self.path == "/raft/append-entries":
                entries = [
                    LogEntry(term=int(entry["term"]), command=entry.get("command"))
                    for entry in payload.get("entries", [])
                ]
                request = AppendEntriesRequest(
                    term=int(payload["term"]),
                    leader_id=str(payload["leader_id"]),
                    prev_log_index=int(payload["prev_log_index"]),
                    prev_log_term=int(payload["prev_log_term"]),
                    entries=entries,
                    leader_commit=int(payload["leader_commit"]),
                )
                result = self.node.handle_append_entries(request)
                self._send_json(
                    200,
                    {
                        "term": result.term,
                        "success": result.success,
                        "match_index": result.match_index,
                        "reason": result.reason,
                    },
                )
                return

            self._send_json(404, {"error": "unknown endpoint"})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": f"invalid request: {exc}"})


def start_server(node: RaftNode, host: str = "127.0.0.1", port: int = 8081) -> HTTPServer:
    handler = type("BoundRaftRPCHandler", (RaftRPCHandler,), {"node": node})
    server = HTTPServer((host, port), handler)
    return server


if __name__ == "__main__":
    local_node = RaftNode(node_id="replica-1")
    server = start_server(local_node)
    print("RAFT replica RPC server listening on http://127.0.0.1:8081")
    server.serve_forever()
