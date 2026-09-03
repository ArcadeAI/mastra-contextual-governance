# @cg/governance-core

The governance layer: hook framework, policy engine, redaction, audit, event bus. Free of
business-domain vocabulary and — enforced by `test/no-app-dependencies.test.ts` — of any
dependency on `apps/*`. Forking means replacing the governed app and touching nothing here.

## PolicyEngine (`src/policy-engine.ts`, #7)

Pure. No I/O, no clock, no randomness. Two questions:

```ts
import { compilePolicy, resolveVisibility, evaluatePermission } from "@cg/governance-core";

const policy = compilePolicy({
  // Every governed toolkit (the ARCADE_*_TOOLKIT values from config, never
  // hardcoded), the tools it serves, and the arguments each call must supply.
  // Required: it is the typo check at compile time, the fail-closed boundary
  // at runtime, and what lets the compiler check remediation instructions.
  catalogue: {
    [toolkitName]: { get_widget: ["widget_id"], update_widget: ["widget_id", "quantity"] },
    Approvals: { request_approval: ["resource_id", "quantity", "justification"] },
  },
  rules,   // PolicyRule[] from governance.db
});

// /access — which tools may this subject see at all
resolveVisibility(subject, tools, policy);   // → { tool, decision }[]

// /pre — may this subject make *this* call, with *these* argument values
evaluatePermission({ subject, tool, inputs, policy, grants });   // → Decision
```

`subject` is `Subject | null` — the hook handler (#12) resolves `context.user_id` to a
`Subject`; `null` means nobody matched. `grants` are grants #10 has already judged valid;
the engine only checks that one applies to this subject and tool.

### What a decision means

| Situation | `effect` | `rule_id` |
|---|---|---|
| A rule matched | the rule's | the rule's id |
| A `pre` rule would deny, but an applicable grant is present | `allow` | the rule the grant lifted |
| A catalogued tool that no rule speaks about | `allow` | `null` |
| Unknown subject | `deny` | `null` |
| Toolkit not in the catalogue | `deny` | `null` |
| Tool not in its toolkit's catalogue entry (typo, case, prefix, or a tool the policy never heard of) | `deny` | `null` |
| A `/pre` call missing a catalogued argument of its tool | `deny` | `null` |
| A rule's condition reads an input that is missing or of the wrong type | `deny` | that rule's id |

Rules are evaluated in ascending `priority`, ties broken by `id`; first match wins.
Disabled rules never fire.

### Why `compilePolicy` throws

A rule that matches nothing is indistinguishable at runtime from a rule that permits. So
compilation is loud: it refuses, with every problem listed, a rule whose toolkit or tool the
catalogue does not list, whose condition value makes no sense for its operator (`gt "10"`,
`in "eu"`, an invalid regex), an `access` rule with conditions (there are no inputs at
`/access`), a `modify` effect, a duplicate id, a `reason` placeholder rooted outside
`inputs`, `subject` or `tool` — and a `pre` denial whose reason is not actionable (below).

### Denial reasons

Over MCP the model sees `"Tool execution was denied by an extension policy: " + reason`
and nothing else. A rule's `reason` should therefore name the next tool to call and the
arguments it needs, and may interpolate the call:

```
DENIED: {{inputs.quantity}} exceeds your {{subject.clearance}} clearance.
To proceed, call Approvals.request_approval with resource_id={{inputs.widget_id}},
quantity={{inputs.quantity}} and justification=<why>, then retry this call unchanged.
```

Placeholders are exactly two segments and every one is provable at compile time:
`{{inputs.<argument>}}` where the argument is catalogued for *every* tool the rule can match
(the engine requires those inputs on the call, so the value is always there),
`{{subject.user_id|display_name|role|clearance}}`, and `{{tool.toolkit|name}}`. A placeholder
the engine cannot guarantee to fill is a compile error, not a `(not provided)` at runtime, and
so is any `{{` or `}}` that does not form a placeholder — `{{}}` included.

**This is enforced, not advised.** A `pre` rule with `effect: deny` fails to compile unless
its `reason` either contains the words `Do not retry`, which tells the model to stop rather
than guess (and then instructs no call at all), or names a catalogued tool as `Toolkit.tool`
*and*, after that name, spells out as `name=value` every argument the catalogue lists for
that tool. The reason is read as one left-to-right token stream. Arguments belong to the
`Toolkit.tool` reference they follow, and *any* such reference closes the previous one,
catalogued or not, so arguments cannot drift onto a tool that was not named for them;
arguments given to an uncatalogued reference are refused. The value is a `{{inputs.…}}`
placeholder, a `<what to supply>` instruction, a non-empty quoted string or a bare literal
with no brace, angle or quote characters; `name=` with nothing usable after it is refused,
and so is an argument the tool does not accept. So `"Insufficient authority."` is refused as
an apology, `"…with banana=1."` for the unknown argument, `"…with resource_id=, quantity=,
justification=."` and `"…resource_id={{}}, …"` for the missing values, two tools with
swapped argument lists for both, and `"Call Approvals.request_approval; then
Bogus.do_thing with resource_id=…"` because the arguments follow a tool that does not exist. Access denials are exempt: they hide
the tool, and the model never reads them.

Engine-authored reasons (the fail-closed rows above) follow the same standard: they name the
tool and input, and say whether a retry can fix it.

### Conditions

All conditions on a rule must hold. `input` is a dot path into the call's inputs.

| operator | value | fires when |
|---|---|---|
| `eq` / `neq` | any | input equals / differs from value (structural) |
| `gt` `gte` `lt` `lte` | number | numeric comparison |
| `in` / `nin` | array | input is / is not a member |
| `matches` | regex source | input is a string matching it |
| `exists` | omitted or `true` | input is present and not `null` |
| `exists` | `false` | input is absent or `null` |
| `exceeds_clearance` | none | input is a number greater than `subject.clearance` |

Numbers are not coerced: `"95"` is malformed, not ninety-five, and the denial says so and
asks for a number. The limit itself is inclusive — exactly at clearance is allowed.
