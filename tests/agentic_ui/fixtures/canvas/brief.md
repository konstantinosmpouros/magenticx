# Σχέδιο έργου: Canvas documents for mAgenticX

This brief describes how the agent and the user write one document together. Η πρόταση συνοψίζει τους στόχους, το εύρος και τα επόμενα βήματα, ώστε η ομάδα να ξεκινήσει τη Φάση 4.

## 1. Στόχοι — Goals

- **Two writers, one document.** The agent and the user both write versions, and neither silently overwrites the other.
- **Σχόλια πάνω στο κείμενο.** Ο χρήστης σχολιάζει ένα απόσπασμα και ο πράκτορας το βλέπει στην επόμενη απάντησή του.
- **Export that just works.** Every document exports to Word or PDF through `pandoc` in the sandbox.

## 2. Εύρος — Scope

The first release covers markdown documents under `/conversation/output/`. The full design is in the [plan 44 overview](https://github.com/EXARTeo/magenticx/blob/main/plans/44-documents-canvas-artifacts.md).

1. Versions with optimistic concurrency and a conflict dialog.
2. Comments anchored to a passage of text.
3. Suggestions the user can accept or reject one by one.

| Feature | Owner | Κατάσταση |
| --- | --- | --- |
| Versions | dialogue_bridge | Σε εξέλιξη |
| Comments | agentic_ui | Planned |
| Export | sandbox | Done |

## 3. Επόμενα βήματα — Next steps

Η ομάδα θα ολοκληρώσει το spike μέχρι το τέλος της εβδομάδας. *The editor choice is final* once the round-trip test passes in CI.

- **Owner:** Κώστας, with the agent drafting each section.
- **Review:** every open comment is resolved before export.

> Comments are never part of a public share snapshot.
