from __future__ import annotations

from dataclasses import dataclass, field

from .models import AppendEntriesRequest, AppendEntriesResponse, LogEntry, VoteRequest, VoteResponse


@dataclass
class RaftNode:
    node_id: str
    peer_ids: list[str] = field(default_factory=list)
    current_term: int = 0
    voted_for: str | None = None
    log: list[LogEntry] = field(default_factory=list)
    commit_index: int = -1
    state: str = "follower"
    leader_id: str | None = None
    votes_received: set[str] = field(default_factory=set)
    next_index: dict[str, int] = field(default_factory=dict)
    match_index: dict[str, int] = field(default_factory=dict)
    election_timeout_ticks: int = 10
    heartbeat_interval_ticks: int = 3
    _election_elapsed_ticks: int = 0
    _heartbeat_elapsed_ticks: int = 0

    def _last_log_index(self) -> int:
        return len(self.log) - 1

    def _last_log_term(self) -> int:
        if not self.log:
            return 0
        return self.log[-1].term

    def _majority_count(self) -> int:
        total_nodes = len(self.peer_ids) + 1
        return (total_nodes // 2) + 1

    def _reset_election_timer(self) -> None:
        self._election_elapsed_ticks = 0

    def _reset_heartbeat_timer(self) -> None:
        self._heartbeat_elapsed_ticks = 0

    def configure_peers(self, peer_ids: list[str]) -> None:
        self.peer_ids = [peer_id for peer_id in peer_ids if peer_id != self.node_id]
        self.next_index = {peer_id: self._last_log_index() + 1 for peer_id in self.peer_ids}
        self.match_index = {peer_id: -1 for peer_id in self.peer_ids}

    def tick(self) -> str:
        if self.state == "leader":
            self._heartbeat_elapsed_ticks += 1
            if self._heartbeat_elapsed_ticks >= self.heartbeat_interval_ticks:
                self._reset_heartbeat_timer()
                return "heartbeat_due"
            return "idle"

        self._election_elapsed_ticks += 1
        if self._election_elapsed_ticks >= self.election_timeout_ticks:
            self.start_election()
            return "election_started"
        return "idle"

    def start_election(self) -> VoteRequest:
        self.state = "candidate"
        self.current_term += 1
        self.voted_for = self.node_id
        self.votes_received = {self.node_id}
        self.leader_id = None
        self._reset_election_timer()
        return VoteRequest(
            term=self.current_term,
            candidate_id=self.node_id,
            last_log_index=self._last_log_index(),
            last_log_term=self._last_log_term(),
        )

    def become_follower(self, new_term: int, leader_id: str | None = None) -> None:
        self.state = "follower"
        if new_term > self.current_term:
            self.current_term = new_term
            self.voted_for = None
        self.votes_received.clear()
        self.leader_id = leader_id
        self._reset_election_timer()

    def become_leader(self) -> None:
        self.state = "leader"
        self.leader_id = self.node_id
        self.next_index = {peer_id: self._last_log_index() + 1 for peer_id in self.peer_ids}
        self.match_index = {peer_id: -1 for peer_id in self.peer_ids}
        self._reset_heartbeat_timer()

    def handle_vote_response(self, peer_id: str, response: VoteResponse) -> bool:
        if response.term > self.current_term:
            self.become_follower(response.term)
            return False

        if self.state != "candidate" or response.term < self.current_term:
            return False

        if response.vote_granted:
            self.votes_received.add(peer_id)

        if len(self.votes_received) >= self._majority_count():
            self.become_leader()
            return True

        return False

    def _is_candidate_log_up_to_date(self, candidate_last_log_term: int, candidate_last_log_index: int) -> bool:
        local_last_term = self._last_log_term()
        local_last_index = self._last_log_index()

        if candidate_last_log_term != local_last_term:
            return candidate_last_log_term > local_last_term
        return candidate_last_log_index >= local_last_index

    def handle_vote_request(self, request: VoteRequest) -> VoteResponse:
        if request.term < self.current_term:
            return VoteResponse(term=self.current_term, vote_granted=False, reason="stale term")

        if request.term > self.current_term:
            self.become_follower(request.term)

        if request.term == self.current_term and self.state != "follower":
            self.state = "follower"
            self.leader_id = None

        if self.voted_for is not None and self.voted_for != request.candidate_id:
            return VoteResponse(term=self.current_term, vote_granted=False, reason="already voted")

        if not self._is_candidate_log_up_to_date(request.last_log_term, request.last_log_index):
            return VoteResponse(term=self.current_term, vote_granted=False, reason="candidate log behind")

        self.voted_for = request.candidate_id
        self._reset_election_timer()
        return VoteResponse(term=self.current_term, vote_granted=True)

    def handle_append_entries(self, request: AppendEntriesRequest) -> AppendEntriesResponse:
        if request.term < self.current_term:
            return AppendEntriesResponse(
                term=self.current_term,
                success=False,
                match_index=self._last_log_index(),
                reason="stale term",
            )

        if request.term >= self.current_term:
            self.become_follower(request.term, leader_id=request.leader_id)

        if request.prev_log_index >= 0:
            if request.prev_log_index >= len(self.log):
                return AppendEntriesResponse(
                    term=self.current_term,
                    success=False,
                    match_index=self._last_log_index(),
                    reason="missing prev_log_index",
                )
            if self.log[request.prev_log_index].term != request.prev_log_term:
                return AppendEntriesResponse(
                    term=self.current_term,
                    success=False,
                    match_index=request.prev_log_index - 1,
                    reason="prev_log_term mismatch",
                )

        append_index = request.prev_log_index + 1

        for i, new_entry in enumerate(request.entries):
            target = append_index + i
            if target < len(self.log) and self.log[target].term != new_entry.term:
                self.log = self.log[:target]
            if target >= len(self.log):
                self.log.append(new_entry)

        if request.leader_commit > self.commit_index:
            self.commit_index = min(request.leader_commit, self._last_log_index())

        self._reset_election_timer()
        return AppendEntriesResponse(
            term=self.current_term,
            success=True,
            match_index=self._last_log_index(),
        )

    def append_leader_command(self, command: object) -> int:
        if self.state != "leader":
            raise ValueError("only leader can append commands")

        self.log.append(LogEntry(term=self.current_term, command=command))
        return self._last_log_index()

    def build_append_entries_request(self, peer_id: str) -> AppendEntriesRequest:
        if self.state != "leader":
            raise ValueError("only leader can build append entries")

        if peer_id not in self.next_index:
            raise ValueError(f"unknown peer: {peer_id}")

        next_idx = self.next_index[peer_id]
        prev_log_index = next_idx - 1
        prev_log_term = 0 if prev_log_index < 0 else self.log[prev_log_index].term

        return AppendEntriesRequest(
            term=self.current_term,
            leader_id=self.node_id,
            prev_log_index=prev_log_index,
            prev_log_term=prev_log_term,
            entries=self.log[next_idx:],
            leader_commit=self.commit_index,
        )

    def handle_append_entries_response(self, peer_id: str, response: AppendEntriesResponse) -> None:
        if response.term > self.current_term:
            self.become_follower(response.term)
            return

        if self.state != "leader" or response.term < self.current_term:
            return

        if peer_id not in self.next_index:
            raise ValueError(f"unknown peer: {peer_id}")

        if response.success:
            self.match_index[peer_id] = response.match_index
            self.next_index[peer_id] = response.match_index + 1
            self._advance_commit_index()
            return

        self.next_index[peer_id] = max(0, self.next_index[peer_id] - 1)

    def _advance_commit_index(self) -> None:
        last_index = self._last_log_index()
        for candidate_index in range(last_index, self.commit_index, -1):
            if self.log[candidate_index].term != self.current_term:
                continue

            replicated = 1
            for peer_id in self.peer_ids:
                if self.match_index.get(peer_id, -1) >= candidate_index:
                    replicated += 1

            if replicated >= self._majority_count():
                self.commit_index = candidate_index
                return
