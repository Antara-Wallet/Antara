import express, { type Router } from "express";
import { basename, extname, join, resolve } from "node:path";

/** Client-side routes that load the single-page app (main.tsx picks the screen). */
export const SPA_ROUTES = ["/", "/app", "/landing", "/skill", "/docs", "/docs/*", "/download", "/downloads", "/legacy", "/enroll", "/approve", "/e/:code"];

/** Release files are always saved, never rendered or sniffed. Other types fall back to octet-stream. */
const DOWNLOAD_TYPES: Record<string, string> = {
  ".exe": "application/vnd.microsoft.portable-executable",
  ".zip": "application/zip",
};

/**
 * Serves the built frontend (dist/): /downloads/* release files as attachments (manifest.json stays
 * plain JSON for the /download page), the other static files, and index.html for SPA_ROUTES.
 * Directory paths never redirect, so /downloads reaches the SPA instead of a 301 to /downloads/.
 */
export function frontendRouter(directory: string): Router {
  const router = express.Router();
  router.use("/downloads", express.static(join(directory, "downloads"), {
    index: false,
    redirect: false,
    setHeaders(res, filePath) {
      const extension = extname(filePath).toLowerCase();
      if (extension === ".json") return;
      res.setHeader("Content-Type", DOWNLOAD_TYPES[extension] ?? "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${basename(filePath).replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    },
  }));
  router.use(express.static(directory, { index: false, redirect: false }));
  router.get(SPA_ROUTES, (_req, res) => {
    res.sendFile(resolve(directory, "index.html"));
  });
  return router;
}
