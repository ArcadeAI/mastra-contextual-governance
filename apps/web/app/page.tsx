/**
 * Placeholder. The real thing is a split screen: a deliberately boring
 * enterprise loan app on the left, the Arcade control plane on the right.
 * The shell lands in #22, the control-plane panel in #21.
 */
const SERVICES = [
  ["apps/web", "this app — chat, persona switcher, approval page, panel"],
  ["apps/hooks", "the control plane — /access, /pre, /post, audit, SSE"],
  ["apps/loan-mcp", "the governed business system, over Remote MCP"],
  ["tools/approvals", "Python arcade-mcp toolkit — ships via arcade deploy"],
] as const;

export default function Home() {
  return (
    <main
      style={{
        maxWidth: "42rem",
        margin: "0 auto",
        padding: "4rem 1.5rem",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "0.75rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--muted)",
        }}
      >
        Scaffold
      </p>
      <h1 style={{ fontSize: "1.75rem", margin: "0.5rem 0 1rem" }}>
        Contextual Governance — Mastra × Arcade
      </h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Every service is a stub that serves a health endpoint. Nothing else. The
        point of this slice is that the deploy pipeline works before any logic
        goes into it.
      </p>

      <ul style={{ listStyle: "none", padding: 0, marginTop: "2rem" }}>
        {SERVICES.map(([name, role]) => (
          <li
            key={name}
            style={{ borderTop: "1px solid var(--line)", padding: "0.75rem 0" }}
          >
            <code style={{ fontSize: "0.875rem" }}>{name}</code>
            <div style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
              {role}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
