#!/usr/bin/env bash
# Every Python toolkit under tools/, as a JSON array of directory names.
#
#   $ bash scripts/list-toolkits.sh
#   ["approvals","loan"]
#
# CI's `toolkits` job feeds its matrix from this instead of listing names.
# A hardcoded matrix is a job that cds into a directory a forker deleted:
# `tools/approvals` is meant to be deletable — a forker who wants no Python
# removes it and substitutes their own tools — and a workflow that still names
# it turns that supported act into red CI.
#
# `tools/approvals/tests/test_isolation.py` runs this script against a temp
# copy of the repo with the directory actually removed, so the claim is
# measured rather than asserted. Both callers run this one file, which is the
# point: a workflow with its own inline copy of the logic can drift from the
# test that proves the logic.
#
# A toolkit is a directory under tools/ with a pyproject.toml. Nothing else
# qualifies, and no toolkit is named here.
set -uo pipefail

cd "$(dirname "$0")/.."

# No match leaves the glob unexpanded, so ls fails and the pipeline is empty.
# That is the "forker deleted every toolkit" case, and it must be an empty
# array rather than an error.
ls -d tools/*/pyproject.toml 2>/dev/null |
  xargs -n1 dirname 2>/dev/null |
  xargs -n1 basename 2>/dev/null |
  sort |
  python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()], separators=(",", ":")))'
