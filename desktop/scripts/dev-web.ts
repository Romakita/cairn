// Serveur de développement de l'interface seule (sans Electron) : construit src/renderer en mémoire et le sert sur
// http://localhost:5173, recharge la page à chaque modification. Le preload n'existe pas ici : `window.cairn` est
// absent (la galerie et les écrans d'exemple ne l'appellent pas).
//
//   bun run dev:web              → http://localhost:5173/#/gallery
//   bun scripts/dev-web.ts --port 5180 --no-watch
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const rendererDir = path.join(root, "src/renderer");
const RELOAD_PATH = "/__reload";
const RELOAD_SCRIPT = "/__reload.js";

export interface DevServer {
  url: string;
  stop: () => void;
}

interface Built {
  files: Map<string, { body: ArrayBuffer; type: string }>;
  error?: string;
}

async function buildRenderer(): Promise<Built> {
  const result = await Bun.build({
    entrypoints: [path.join(rendererDir, "main.tsx")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });
  const files = new Map<string, { body: ArrayBuffer; type: string }>();
  if (!result.success) return { files, error: result.logs.map(String).join("\n") };
  for (const output of result.outputs) {
    const name = `/${path.basename(output.path)}`;
    files.set(name, { body: await output.arrayBuffer(), type: output.type });
  }
  return { files };
}

/** index.html des sources, avec le script de rechargement (fichier séparé : la CSP refuse les scripts en ligne). */
async function indexHtml(reload: boolean): Promise<string> {
  const html = await readFile(path.join(rendererDir, "index.html"), "utf8");
  return reload ? html.replace("</body>", `    <script src="${RELOAD_SCRIPT}"></script>\n  </body>`) : html;
}

const reloadClient = `new EventSource("${RELOAD_PATH}").addEventListener("reload", () => location.reload());\n`;

export async function startDevServer(
  options: { port?: number; watch?: boolean; quiet?: boolean } = {},
): Promise<DevServer> {
  const port = options.port ?? 5173;
  const live = options.watch ?? true;
  let built = await buildRenderer();
  if (built.error && !options.quiet) console.error(built.error);
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();

  const server = Bun.serve({
    port,
    hostname: "localhost",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === RELOAD_PATH && live) {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            clients.add(c);
            c.enqueue(encoder.encode(": connecté\n\n"));
          },
          cancel() {
            clients.delete(controller);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
      if (pathname === RELOAD_SCRIPT && live) {
        return new Response(reloadClient, { headers: { "content-type": "text/javascript" } });
      }
      if (pathname === "/" || pathname === "/index.html") {
        if (built.error) return new Response(built.error, { status: 500 });
        return new Response(await indexHtml(live), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const file = built.files.get(pathname);
      if (!file) return new Response("Not found", { status: 404 });
      return new Response(file.body, { headers: { "content-type": file.type, "cache-control": "no-store" } });
    },
  });

  let watcher: ReturnType<typeof watch> | undefined;
  if (live) {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const rebuild = () => {
      clearTimeout(pending);
      pending = setTimeout(async () => {
        built = await buildRenderer();
        if (built.error) console.error(built.error);
        else if (!options.quiet) console.log("Interface reconstruite");
        for (const c of clients) c.enqueue(encoder.encode("event: reload\ndata: \n\n"));
      }, 80);
    };
    watcher = watch(path.join(root, "src"), { recursive: true }, rebuild);
  }

  return {
    url: `http://localhost:${server.port}`,
    stop: () => {
      watcher?.close();
      for (const c of clients) c.close();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex > 0 ? Number(process.argv[portIndex + 1]) : undefined;
  const server = await startDevServer({ port, watch: !process.argv.includes("--no-watch") });
  console.log(`Interface : ${server.url}/  ·  galerie : ${server.url}/#/gallery`);
}
