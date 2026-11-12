---
name: autonomy-loop
description: Autonomous work cycle of Sluice across sessions: how to pick the next task, when to stop, how to leave the state. Use it at the start of every session.
---
# Autonomous loop

## Session start
1. Read `docs/ROADMAP.md` (state and next step), the open GitHub issues (`gh issue list`), and `docs/DECISIONS.md` only where
   the task needs it.
2. Priority: blocker/major bugs → task in progress → the first item of **Next** in ROADMAP.

## For each task
1. Short plan written in the message (not in a file).
2. Build it (load the relevant skills first).
3. Write the tests yourself → green.
4. Review the diff inline, with the rules of the reviewer agents in `.claude/agents/`. No subagents, unless the user asks for one (ADR-18).
5. Fix the serious problems found. Review again only after a blocker or high finding.
6. Take the item out of ROADMAP, add a line to CHANGELOG (Unreleased), write a non-obvious decision in DECISIONS (two or three sentences: what and why), commit.
7. On a branch, open a pull request; merge it only after all CI checks pass.

## Before a release
QA and docs inline, with the rules of `qa-explorer` and `docs-writer` (results in the pull request, bugs as issues) → open bugs
fixed or justified → skill `release-checklist` (version bump, annotated tag, ADR-53).

## Gate: stop and ask the user ONLY if
- a change to the visibility or the settings of the repo, or a text would name another product;
- an action needs an account, money or publishing (store, domain, npm publish);
- a destructive or irreversible operation on a git remote;
- two valid solutions with relevant product (not technical) trade-offs.
Otherwise decide, write the decision in DECISIONS, continue.

## Session end
ROADMAP updated with an explicit "next step": the next session must be able to restart with no context.

## Language
Everything in English only, with plain words (see ADR-2).
