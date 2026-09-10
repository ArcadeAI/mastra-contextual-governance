/**
 * The before/after diff, with every removed value masked.
 *
 * Act 3's whole point is that a bank account number never reached the model.
 * This panel is the one surface guaranteed to be on a projector, so printing
 * that number in the diff would be worse than having no diff at all. The rule
 * here is therefore absolute and not a matter of configuration:
 *
 * > **A `before` value is never rendered.** It is replaced by a mask built from
 * > nothing but the value's type. Not truncated, not partially shown, not
 * > hashed — masked.
 *
 * `after` *is* rendered, because `after` is by definition what the control
 * plane let through to the model. Hiding it would leave the diff saying
 * nothing, and a diff that shows neither side does not demonstrate a control.
 *
 * Why every `before` and not just the sensitive ones: a `GovernanceEvent`
 * carries `before` and `after` as opaque payloads and nothing on it says which
 * leaf was masked for being a secret and which was rewritten for carrying an
 * injected instruction. With no way to tell them apart, the safe reading of
 * every removed value is "secret". #8 has landed `RedactionRecord` — path,
 * `rule_id`, `pattern_id`, kind, and deliberately never the removed value — but
 * `GovernanceEvent` does not carry a `redactions[]` array yet, so there is
 * still nothing to read. When one arrives it is purely additive: see
 * {@link DiffRow.annotation}, which exists for exactly that.
 */

/** What happened to one leaf of the payload. */
export type DiffChange = "changed" | "removed" | "added";

/**
 * One line of the diff. `before` is *always* a mask; `after` is the real value
 * rendered as text, or `null` where the leaf was removed outright.
 */
export interface DiffRow {
  /** Dot-and-bracket path into the payload, e.g. `applicant.accounts[0].number`. */
  readonly path: string;
  readonly change: DiffChange;
  /** A mask standing in for the removed value. Never the value. */
  readonly before: string | null;
  /** What the model actually received here. */
  readonly after: string | null;
  /**
   * Extension point for a `redactions[]` array on `GovernanceEvent`: the
   * `rule_id`/`pattern_id` chip naming *why* this leaf changed. #8 has landed
   * the `RedactionRecord` type but the event does not carry them yet, so this
   * is always `null` and the renderer omits the chip.
   */
  readonly annotation: string | null;
}

/**
 * A stand-in for a value, derived from its **type** and never its content.
 *
 * It is a phrase, not a row of dots. The first cut of this panel drew `●●●●●●`
 * and a design review caught the problem: at projector distance a run of dots
 * reads as a value — an account number in a masked font — rather than as the
 * absence of one. A mask has to be unmistakably a mask, so it says so in
 * words, and the renderer puts a hatched field behind it.
 *
 * Saying only the type also leaks strictly less than the dots did. The dots
 * were length-proportional up to a cap, so a short PIN and a long note looked
 * different; these do not.
 */
function mask(value: unknown): string {
  // `null` is not a secret and there is nothing to withhold, so it is named.
  if (value === null) return "null";
  if (typeof value === "string") return "text withheld";
  if (typeof value === "number") return "number withheld";
  if (typeof value === "boolean") return "value withheld";
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"} withheld`;
  }
  if (typeof value === "object") return "object withheld";
  return "value withheld";
}

/** How a surviving value reads on screen. Only ever applied to `after`. */
function show(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * The leaves that differ between `before` and `after`, deepest-first within
 * each branch, in the payload's own key order.
 *
 * Unchanged leaves are omitted — that is what makes the diff readable from
 * across a room. A `modify` whose payloads are identical yields no rows, and
 * the renderer says so rather than drawing an empty box.
 */
export function maskedDiff(before: unknown, after: unknown): DiffRow[] {
  const rows: DiffRow[] = [];

  function walk(path: string, left: unknown, right: unknown): void {
    if (isRecord(left) && isRecord(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(join(path, key), key in left ? left[key] : undefined, key in right ? right[key] : undefined);
      }
      return;
    }

    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        walk(`${path}[${index}]`, left[index], right[index]);
      }
      return;
    }

    if (left === undefined && right === undefined) return;

    if (left === undefined) {
      rows.push({ path, change: "added", before: null, after: show(right), annotation: null });
      return;
    }
    if (right === undefined) {
      rows.push({ path, change: "removed", before: mask(left), after: null, annotation: null });
      return;
    }

    // Two values of different shape, or two differing leaves. `JSON.stringify`
    // is the comparison rather than `===` so an object replaced by an object
    // with the same contents does not read as a change.
    if (JSON.stringify(left) === JSON.stringify(right)) return;

    rows.push({ path, change: "changed", before: mask(left), after: show(right), annotation: null });
  }

  walk("", before, after);
  return rows;
}
