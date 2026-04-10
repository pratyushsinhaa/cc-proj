
Cloud Computing Project

Team:
Pratyush Sinha - PES2UG23CS441
Prakhar Kumar - PES2UG23CS425
Preetham R Sanji - PES2UG23CS442
Rahul Anand - PES2UG23CS461

## Pratyush Branch Progress (RAFT Core Complete)

This branch now implements the RAFT core scope owned by Pratyush:

1. Term management and vote handling in replica state.
2. Vote request freshness checks using `(lastLogTerm, lastLogIndex)`.
3. Replica RPC endpoints:
	- `POST /raft/request-vote`
	- `POST /raft/append-entries`
4. Append-entries validation, conflict handling, and log append behavior.
5. Election timeout tick loop and candidate transition flow.
6. Leader-side replication bookkeeping (`nextIndex`, `matchIndex`).
7. Majority commit advancement logic.

Integration dependencies (outside this branch's ownership):

1. Gateway/service wiring to call replica RPC endpoints in a running multi-node setup.
2. Frontend event pipeline and docs runbook integration.

## Local Verification

```bash
python3 -m unittest discover -s tests -v
```
