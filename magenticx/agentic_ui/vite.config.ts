import { defineConfig } from "vite";
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

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()].filter(Boolean),
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
