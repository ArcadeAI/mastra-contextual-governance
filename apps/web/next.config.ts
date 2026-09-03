import type { NextConfig } from "next";

const config: NextConfig = {
  // Render runs this service from a Dockerfile; standalone keeps the runtime
  // image to the server plus only the dependencies it actually traced.
  output: "standalone",
  // The monorepo root, so tracing picks up files linked from packages/.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
};

export default config;
