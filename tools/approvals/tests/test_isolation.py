"""A forker who wants no Python deletes this directory, and nothing breaks.

That is an acceptance criterion, so it is a test rather than a claim. Two
directions, and both matter:

  * nothing under `apps/` or `packages/` reaches *into* this toolkit, so
    deleting it cannot break the services or the shared packages;
  * nothing in this toolkit's *runtime* reaches out of it, so it can be lifted
    into another repo whole.

The tests do reach out — they read the cross-language routing cases under
`packages/policy-schema/contract/`, deliberately, because agreement with the
TypeScript router is the thing worth checking. That direction is safe: the
JSON has another reader and survives this directory's deletion.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TOOLKIT = REPO_ROOT / "tools" / "approvals"
RUNTIME = TOOLKIT / "approvals"


def _sources(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    skip = {"node_modules", ".venv", "__pycache__", ".next", "dist", ".git"}
    return [
        path
        for path in root.rglob("*")
        if path.suffix in suffixes
        and path.is_file()
        and not any(part in skip for part in path.parts)
    ]


class TestNothingReachesIn:
    def test_no_typescript_imports_this_toolkit(self) -> None:
        # An import or a require, not a mention: a comment naming the toolkit
        # is documentation and survives its deletion intact.
        reaches_in = re.compile(r"""(?:from|import|require\()\s*['"][^'"]*tools/approvals""")
        offenders = [
            str(path.relative_to(REPO_ROOT))
            for directory in (REPO_ROOT / "apps", REPO_ROOT / "packages")
            for path in _sources(directory, (".ts", ".tsx"))
            if reaches_in.search(path.read_text(encoding="utf-8"))
        ]
        assert offenders == [], offenders

    def test_it_is_not_a_bun_workspace(self) -> None:
        # Deleting a workspace member breaks `bun install`. This is not one.
        manifest = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        assert not any("tools" in pattern for pattern in manifest["workspaces"])

    def test_it_is_not_a_render_service(self) -> None:
        # It ships with `arcade deploy`; a blueprint entry would make deleting
        # the directory a failed sync.
        blueprint = (REPO_ROOT / "render.yaml").read_text(encoding="utf-8")
        # Comments in the blueprint say why it is absent; those are the point.
        declarations = [
            line
            for line in blueprint.splitlines()
            if "tools/approvals" in line and not line.lstrip().startswith("#")
        ]
        assert declarations == [], declarations

    def test_it_carries_no_package_manifest_the_workspace_could_pick_up(self) -> None:
        assert not (TOOLKIT / "package.json").exists()


class TestNothingReachesOut:
    def test_the_runtime_imports_only_itself_and_its_declared_dependencies(self) -> None:
        allowed_prefixes = (
            "approvals.",
            "arcade_core",
            "arcade_mcp_server",
            "httpx",
        )
        stdlib = {"__future__", "enum", "os", "math", "dataclasses", "typing", "sys", "json"}
        for path in _sources(RUNTIME, (".py",)):
            for line in path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not stripped.startswith(("import ", "from ")):
                    continue
                module = stripped.split()[1]
                assert module in stdlib or module.startswith(allowed_prefixes), (
                    f"{path.relative_to(REPO_ROOT)}: {stripped}"
                )

    def test_the_runtime_reads_no_file_outside_this_directory(self) -> None:
        # A fixture path into packages/ would make the deployed toolkit depend
        # on a repo layout it does not ship with.
        for path in _sources(RUNTIME, (".py",)):
            source = path.read_text(encoding="utf-8")
            assert "parents[" not in source, path.relative_to(REPO_ROOT)
            assert "open(" not in source, path.relative_to(REPO_ROOT)
