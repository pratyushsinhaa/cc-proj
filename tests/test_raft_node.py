import unittest

from raft_core.models import AppendEntriesRequest, AppendEntriesResponse, LogEntry, VoteRequest, VoteResponse
from raft_core.node import RaftNode


class RaftNodeVoteTests(unittest.TestCase):
    def test_rejects_vote_for_stale_term(self) -> None:
        node = RaftNode(node_id="n1", current_term=3)

        result = node.handle_vote_request(
            VoteRequest(
                term=2,
                candidate_id="cand",
                last_log_index=-1,
                last_log_term=0,
            )
        )

        self.assertFalse(result.vote_granted)
        self.assertEqual(3, result.term)

    def test_rejects_when_candidate_log_is_behind(self) -> None:
        node = RaftNode(node_id="n1", current_term=2)
        node.log.append(LogEntry(term=2, command={"set": "x"}))

        result = node.handle_vote_request(
            VoteRequest(
                term=2,
                candidate_id="cand",
                last_log_index=0,
                last_log_term=1,
            )
        )

        self.assertFalse(result.vote_granted)
        self.assertEqual("candidate log behind", result.reason)

    def test_grants_vote_and_records_voter(self) -> None:
        node = RaftNode(node_id="n1", current_term=1)

        result = node.handle_vote_request(
            VoteRequest(
                term=2,
                candidate_id="cand-1",
                last_log_index=-1,
                last_log_term=0,
            )
        )

        self.assertTrue(result.vote_granted)
        self.assertEqual(2, node.current_term)
        self.assertEqual("cand-1", node.voted_for)


class RaftNodeAppendTests(unittest.TestCase):
    def test_rejects_append_for_missing_previous_index(self) -> None:
        node = RaftNode(node_id="n1", current_term=2)

        result = node.handle_append_entries(
            AppendEntriesRequest(
                term=2,
                leader_id="leader",
                prev_log_index=0,
                prev_log_term=2,
                entries=[LogEntry(term=2, command={"set": "a"})],
                leader_commit=0,
            )
        )

        self.assertFalse(result.success)
        self.assertEqual("missing prev_log_index", result.reason)

    def test_appends_entries_and_updates_commit_index(self) -> None:
        node = RaftNode(node_id="n1", current_term=2)

        result = node.handle_append_entries(
            AppendEntriesRequest(
                term=2,
                leader_id="leader",
                prev_log_index=-1,
                prev_log_term=0,
                entries=[
                    LogEntry(term=2, command={"set": "a"}),
                    LogEntry(term=2, command={"set": "b"}),
                ],
                leader_commit=1,
            )
        )

        self.assertTrue(result.success)
        self.assertEqual(1, node.commit_index)
        self.assertEqual(2, len(node.log))

    def test_same_term_append_keeps_existing_vote(self) -> None:
        node = RaftNode(node_id="n1", current_term=3, voted_for="cand-1")

        result = node.handle_append_entries(
            AppendEntriesRequest(
                term=3,
                leader_id="leader-1",
                prev_log_index=-1,
                prev_log_term=0,
                entries=[],
                leader_commit=-1,
            )
        )

        self.assertTrue(result.success)
        self.assertEqual("cand-1", node.voted_for)


class RaftNodeElectionAndReplicationTests(unittest.TestCase):
    def test_tick_starts_election_after_timeout(self) -> None:
        node = RaftNode(node_id="n1", peer_ids=["n2", "n3"], election_timeout_ticks=2)

        self.assertEqual("idle", node.tick())
        self.assertEqual("election_started", node.tick())
        self.assertEqual("candidate", node.state)
        self.assertEqual(1, node.current_term)
        self.assertEqual("n1", node.voted_for)

    def test_candidate_becomes_leader_on_majority_votes(self) -> None:
        node = RaftNode(node_id="n1", peer_ids=["n2", "n3"])
        node.start_election()

        promoted = node.handle_vote_response(peer_id="n2", response=VoteResponse(term=1, vote_granted=True))

        self.assertTrue(promoted)
        self.assertEqual("leader", node.state)
        self.assertEqual("n1", node.leader_id)
        self.assertEqual(0, node.next_index["n2"])
        self.assertEqual(0, node.next_index["n3"])

    def test_leader_replication_advances_commit_index_on_majority_ack(self) -> None:
        node = RaftNode(node_id="n1", peer_ids=["n2", "n3"])
        node.start_election()
        node.handle_vote_response(peer_id="n2", response=VoteResponse(term=1, vote_granted=True))

        node.append_leader_command({"set": "x"})
        request = node.build_append_entries_request("n2")

        self.assertEqual(1, request.term)
        self.assertEqual(-1, request.prev_log_index)
        self.assertEqual(1, len(request.entries))

        node.handle_append_entries_response(
            peer_id="n2",
            response=AppendEntriesResponse(term=1, success=True, match_index=0),
        )

        self.assertEqual(0, node.match_index["n2"])
        self.assertEqual(1, node.next_index["n2"])
        self.assertEqual(0, node.commit_index)

    def test_append_rejection_decrements_next_index_for_retry(self) -> None:
        node = RaftNode(node_id="n1", peer_ids=["n2", "n3"])
        node.start_election()
        node.handle_vote_response(peer_id="n2", response=VoteResponse(term=1, vote_granted=True))
        node.append_leader_command({"set": "a"})
        node.next_index["n2"] = 1

        node.handle_append_entries_response(
            peer_id="n2",
            response=AppendEntriesResponse(term=1, success=False, match_index=-1),
        )

        self.assertEqual(0, node.next_index["n2"])

    def test_higher_term_append_response_forces_step_down(self) -> None:
        node = RaftNode(node_id="n1", peer_ids=["n2", "n3"])
        node.start_election()
        node.handle_vote_response(peer_id="n2", response=VoteResponse(term=1, vote_granted=True))

        node.handle_append_entries_response(
            peer_id="n2",
            response=AppendEntriesResponse(term=2, success=False, match_index=-1),
        )

        self.assertEqual("follower", node.state)
        self.assertEqual(2, node.current_term)


if __name__ == "__main__":
    unittest.main()
