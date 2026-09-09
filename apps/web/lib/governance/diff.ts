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
 * Why every `before` and not just the sensitive ones: on `main` today a
 * `GovernanceEvent` carries `before` and `after` as opaque payloads and nothing
 * says which leaf was masked for being a secret and which was rewritten for
 * carrying an injected instruction. With no way to tell them apart, the safe
 * reading of every removed value is "secret". When #8's `redactions[]` lands —
 * path, `rule_id`, `pattern_id`, kind, and never the removed value — it is
 * additive: see {@link DiffRow.annotation}, which exists for exactly that and
 * is unpopulated until then.
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
   * Extension point for #8's `redactions[]`: the `rule_id`/`pattern_id` chip
   * that names *why* this leaf changed. Always `null` until #8 lands, and the
   * renderer omits the chip when it is.
   */
  readonly annotation: string | null;
}

/** Longest mask we will draw. Beyond this the length itself stops being a hint. */
const MASK_CAP = 12;

/**
 * A stand-in for a value, derived from its type and never its content.
 *
 * Strings get a run of dots — enough to read as "text was here", capped so a
 * long note does not draw a long ribbon across the projector. Everything else
 * gets a word, because the shape of a boolean or a null is not a secret and
 * `●` would be less informative than `false`.
 */
function mask(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "●".repeat(Math.min(Math.max(value.length, 1), MASK_CAP));
  if (typeof value === "number") return "●●●";
  if (typeof value === "boolean") return "●●●";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return "{…}";
  return "●●●";
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
