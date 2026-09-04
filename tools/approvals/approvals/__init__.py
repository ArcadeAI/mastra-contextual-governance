"""Approvals toolkit.

A Python `arcade-mcp` toolkit, like its sibling `tools/loan`: outside the Bun
workspaces and outside `render.yaml`, shipped with `arcade deploy`. Python
because `arcade-mcp`, the framework the agent's tools are authored in, is
Python-only — the boundary is tool authoring, not domain.

Stub for now. `request_approval` and `decide` land in #18 and #19. Whatever
`MCPApp(name=...)` #18 picks is what Arcade PascalCases into the toolkit name;
`.env.example` predicts `Approvals` from `name="approvals"` (see #35).
"""

__all__ = ["__version__"]

__version__ = "0.0.0"
