import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

/**
 * Vendor groups split out of the entry chunk (plan 45). Libraries change far
 * less often than the app, so as their own files they stay cached across
 * releases instead of being re-downloaded inside a new entry chunk each time.
 *
 * Only libraries the first page loads anyway belong here: a group is one file,
 * so a library that only a lazy page uses would be pulled into the first
 * download by joining a group.
 */
const VENDOR_GROUPS: ReadonlyArray<[name: string, pattern: RegExp]> = [
  [
    "react",
    /\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)\//,
  ],
  ["radix", /\/node_modules\/@radix-ui\//],
  ["data", /\/node_modules\/(@tanstack\/(react-query|query-core)|zod|zustand)\//],
];

/**
 * KaTeX and rehype-raw on demand (plan 45). Streamdown imports `rehype-katex`
 * (KaTeX, ~260 KB), KaTeX's stylesheet and `rehype-raw` (parse5, ~125 KB) at
 * its module top, which put them all in the entry chunk. Those imports are
 * pointed at `src/shared/lib/lazyRehypeKatex.ts`, an empty module and
 * `lazyRehypeRaw.ts`, which load the real ones in their own chunks when an
 * answer needs them. Only imports made *by Streamdown* are redirected, so the
 * shims' own `import("rehype-katex")` / `import("rehype-raw")` reach the
 * packages. Build only: the dev server pre-bundles Streamdown with esbuild.
 */
function lazyStreamdownPlugins(): Plugin {
  const emptyStylesheet = "\0streamdown-katex-css";
  const streamdownFile = /[\\/]node_modules[\\/]streamdown[\\/]/;
  return {
    name: "lazy-streamdown-plugins",
    apply: "build",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !streamdownFile.test(importer)) return null;
      if (source === "rehype-katex") {
        return path.resolve(__dirname, "./src/shared/lib/lazyRehypeKatex.ts");
      }
      if (source === "rehype-raw") {
        return path.resolve(__dirname, "./src/shared/lib/lazyRehypeRaw.ts");
      }
      if (source === "katex/dist/katex.min.css") return emptyStylesheet;
      return null;
    },
    load(id) {
      return id === emptyStylesheet ? "export {};" : null;
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), lazyStreamdownPlugins()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const normalized = id.replace(/\\/g, "/");
          for (const [name, pattern] of VENDOR_GROUPS) {
            if (pattern.test(normalized)) return name;
          }
          return undefined;
        },
      },
    },
  },
}));
