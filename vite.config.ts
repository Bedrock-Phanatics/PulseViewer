import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const notices = [
  ["LICENSE.txt", new URL("./LICENSE", import.meta.url)],
  ["NOTICE.txt", new URL("./NOTICE", import.meta.url)],
  ["THIRD_PARTY_NOTICES.txt", new URL("./node_modules/vite/LICENSE.md", import.meta.url)],
] as const;

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "license-notices",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          for (const [fileName, source] of notices) {
            if (request.url !== `/${fileName}`) continue;
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.end(readFileSync(source));
            return;
          }
          next();
        });
      },
      generateBundle() {
        for (const [fileName, source] of notices) {
          this.emitFile({
            type: "asset",
            fileName,
            source: readFileSync(source),
          });
        }
      },
    },
  ],
});
