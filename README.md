# Contextual Governance — Mastra × Arcade

An agent that does real work in a real business system, with [Arcade](https://arcade.dev)
enforcing deterministic control at three points on every tool call: **access**,
**pre-execution**, and **post-execution**.

A loan officer asks the agent to approve a $95K loan and to double-check its work. Four
things go wrong. The control plane catches all four. The model never gets a vote.

Built with [Mastra](https://mastra.ai), Next.js, Bun, SQLite, and TypeScript — plus one
Python `arcade-mcp` toolkit.

## Status

Nothing is built yet. See [`DESIGN.md`](./DESIGN.md) for the architecture and the
decisions behind it, and [issue #1](https://github.com/ArcadeAI/mastra-contextual-governance/issues/1)
for the PRD and the work breakdown.

Scaffold lands in #4.
