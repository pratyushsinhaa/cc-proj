from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LogEntry:
    term: int
    command: Any


@dataclass(frozen=True)
class VoteRequest:
    term: int
    candidate_id: str
    last_log_index: int
    last_log_term: int


@dataclass(frozen=True)
class VoteResponse:
    term: int
    vote_granted: bool
    reason: str = ""


@dataclass(frozen=True)
class AppendEntriesRequest:
    term: int
    leader_id: str
    prev_log_index: int
    prev_log_term: int
    entries: list[LogEntry]
    leader_commit: int


@dataclass(frozen=True)
class AppendEntriesResponse:
    term: int
    success: bool
    match_index: int
    reason: str = ""
