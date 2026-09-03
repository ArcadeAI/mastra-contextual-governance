# tools/loan

The loan tools — `search_loans`, `get_loan`, `approve_loan`, `deny_loan` — as a
Python `arcade-mcp` toolkit. Each tool is a stateless client of
[`apps/loan-app`](../../apps/loan-app), the bank's system of record. Nothing here
holds state, and nothing here decides anything.

The tool descriptions came across from the previous MCP surface verbatim. They
were written to be picked by a model without prompt coaching and reviewed on
that basis; the wording is the asset.

## Identity, not authority

Every tool requires OAuth against our own identity provider, `apps/idp` (#36),
registered in Arcade under the provider id `cg-idp` (#13). The tool forwards the
user's token to the API as a bearer token and the API derives the actor from it.
No tool takes an actor as an argument — the test suite asserts that.

The auth requirement is a credential check, not the governance gate. Arcade
evaluates it *before* the `/pre` hook, so a refusal there fires no hook, writes
no audit row and shows nothing on the panel. Limits, roles and separation of
duties stay in `apps/hooks`.

## Configuration

One value: `LOAN_APP_PUBLIC_HOST`, HOST-form like every address in this repo.
It reaches the deployed toolkit as an Arcade secret, uploaded by `arcade deploy`
from the repo's `.env`, because a secret is the one configuration channel a
deployed toolkit has.

## Run and test

```sh
uv sync --extra dev
uv run --extra dev pytest        # boots the real apps/loan-app under Bun
uv run server.py http            # Streamable HTTP on 127.0.0.1:8000
```

## Deploy

```sh
arcade deploy                    # from this directory
```

`arcade deploy` starts `server.py`, reads `serverInfo.name` and `version` off
its `initialize` response, and ships the package under that name. The name is
the `MCPApp(name=...)` in `loan/__init__.py`, not the package name in
`pyproject.toml` — they happen to agree here.

## The toolkit name, measured

See `ARCADE_LOAN_TOOLKIT` in `.env.example` and the report on #35. The section
below is filled from real payloads, never from a derivation.

_Measurement pending — see #35._
