// Bundles the extension, and the harness MCP server it ships beside it, for Node.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  const contexts = await Promise.all([
    esbuild.context({
      ...shared,
      entryPoints: ["src/extension.ts"],
      outfile: "dist/extension.js",
      external: ["vscode"],
    }),
    // The harness MCP server: a standalone process Claude starts, reading the same
    // state file as the extension. No `vscode` external, because it must not need one.
    esbuild.context({
      ...shared,
      entryPoints: ["src/mcp/main.ts"],
      outfile: "dist/harnessMcpServer.js",
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
