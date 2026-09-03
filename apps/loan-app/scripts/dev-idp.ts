/**
 * A stand-in identity provider for local development. NOT the real one.
 *
 * `apps/loan-app` validates every bearer token by asking the issuer's
 * `/oauth2/userinfo` who it belongs to. The real issuer is `apps/idp` (#36);
 * until it is running locally, this serves that one endpoint so the API can be
 * driven by hand:
 *
 *     bun run dev:idp                       # :8083, which is the default IDP_PUBLIC_HOST
 *     curl -H 'Authorization: Bearer dev:dana@example.test' localhost:8082/loans
 *
 * A token is `dev:<email>`; the email after the prefix is who you are. That
 * is the whole protocol, so this must never run anywhere but a laptop. It
 * lives under `scripts/`, outside the `src/` the boundary test scans, and
 * outside the Docker image.
 */
const port = Number(process.env.PORT ?? 8083);

const server = Bun.serve({
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ status: "ok", service: "dev-idp" });
    if (pathname !== "/oauth2/userinfo") return new Response("Not found", { status: 404 });

    const token = /^Bearer\s+dev:(\S+@\S+)$/i.exec(request.headers.get("authorization") ?? "");
    if (token === null) {
      return Response.json(
        { error: "invalid_token", error_description: "Use `Bearer dev:<email>`." },
        { status: 401 },
      );
    }

    const email = token[1]!;
    return Response.json({ sub: email, email, email_verified: true });
  },
});

console.log(`[dev-idp] listening on :${server.port} — tokens are \`dev:<email>\`. Not for anything real.`);
