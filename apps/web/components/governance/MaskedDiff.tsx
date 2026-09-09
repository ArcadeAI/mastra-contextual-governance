/**
 * The before/after diff for a `modify`.
 *
 * A unified stack rather than two side-by-side columns: a lane is a third of
 * half a screen, and two columns at that width wrap every value into an
 * unreadable ribbon. Stacked, each changed leaf reads as three short lines,
 * which is also the form a developer already knows from a diff.
 *
 * Every `before` here is a mask produced by `maskedDiff()`. This component
 * cannot print a removed value because it is never handed one.
 */
import { maskedDiff } from "../../lib/governance/diff.ts";

export function MaskedDiff({ before, after }: { before: unknown; after: unknown }) {
  const rows = maskedDiff(before, after);

  if (rows.length === 0) {
    return (
      <div className="cg-diff">
        <p className="cg-diff-empty">The payload came back unchanged.</p>
      </div>
    );
  }

  return (
    <div className="cg-diff">
      {rows.map((row) => (
        <div className="cg-diff-row" key={row.path}>
          <div className="cg-diff-path">{row.path === "" ? "(whole payload)" : row.path}</div>
          {row.before !== null && (
            <div className="cg-diff-before">
              <span className="cg-diff-sign" aria-hidden="true">
                −
              </span>
              <span>
                <span className="cg-visually-hidden">Removed: </span>
                {row.before}
              </span>
            </div>
          )}
          {row.after !== null && (
            <div className="cg-diff-after">
              <span className="cg-diff-sign" aria-hidden="true">
                +
              </span>
              <span>
                <span className="cg-visually-hidden">Kept: </span>
                {row.after}
              </span>
            </div>
          )}
          {/* Populated when #8's `redactions[]` lands: the rule_id / pattern_id
              that names why this leaf changed. Absent until then. */}
          {row.annotation !== null && <div className="cg-diff-path">{row.annotation}</div>}
        </div>
      ))}
    </div>
  );
}
