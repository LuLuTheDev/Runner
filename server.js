// BoTCloud Runner - sem dependencias, Node 18+
// Implementa o protocolo do painel: /health, /v1/(bots|apps)/:id/(start|stop|restart|status|logs|metrics)
const http = require("http"), fs = require("fs"), path = require("path");
const { spawn, execFile } = require("child_process");

const PORT = +process.env.PORT || 8080;
const KEY = (process.env.RUNNER_KEY || "").trim();
const DASH = (process.env.DASHBOARD_URL || "").trim().replace(/\/+$/, "");
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
if (!KEY || !DASH) { console.error("Defina RUNNER_KEY e DASHBOARD_URL."); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });

const apps = new Map();
const STATE = path.join(DATA, "state.json");
const iso = () => new Date().toISOString();

function saveState() {
  const list = [...apps.values()].filter(a => a.want).map(a => a.id);
  try { fs.writeFileSync(STATE, JSON.stringify(list)); } catch {}
}
function getApp(id) {
  if (!apps.has(id)) apps.set(id, { id, status: "stopped", want: false, logs: [], secrets: [], crashes: [], restarts: 0, child: null, startedAt: 0, auto: true });
  return apps.get(id);
}
function log(a, level, msg) {
  for (const s of a.secrets) msg = msg.split(s).join("***");
  for (const line of String(msg).split(/\r?\n/)) if (line.trim()) a.logs.push({ timestamp: iso(), level, message: line });
  if (a.logs.length > 1500) a.logs.splice(0, 500);
}
function parseEnv(t) {
  const o = {};
  for (const l of t.split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) o[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return o;
}
function run(a, cmd, args, opts) {
  return new Promise(resolve => {
    const c = spawn(cmd, args, opts);
    c.stdout.on("data", d => log(a, "info", d.toString()));
    c.stderr.on("data", d => log(a, "warning", d.toString()));
    c.on("error", e => { log(a, "error", cmd + ": " + e.message); resolve(1); });
    c.on("close", resolve);
  });
}

async function launch(a) {
  if (a.child || a.status === "starting") return;
  a.status = "starting"; a.want = true; saveState();
  try {
    log(a, "info", "Baixando arquivos do painel...");
    const r = await fetch(DASH + "/api/runner/" + a.id + "/bundle", { headers: { Authorization: "Bearer " + KEY }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("O painel respondeu " + r.status + " ao buscar os arquivos (confira DASHBOARD_URL, a chave e se o site esta publico).");
    const b = await r.json();
    if (!b.files || !b.files.length) throw new Error("A aplicacao nao tem arquivos. Envie o codigo no painel primeiro.");
    const meta = b.project || {};
    a.auto = meta.auto_restart !== false;

    const dir = path.join(DATA, a.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f !== "node_modules") fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    for (const f of b.files) {
      const full = path.resolve(dir, f.path);
      if (!full.startsWith(dir + path.sep)) continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content);
    }
    const has = n => fs.existsSync(path.join(dir, n));
    const py = /py/i.test(meta.runtime || "") || (!has("package.json") && (has("requirements.txt") || /\.py$/.test(meta.entry_file || "")));

    const fileEnv = has(".env") ? parseEnv(fs.readFileSync(path.join(dir, ".env"), "utf8")) : {};
    a.secrets = Object.values(fileEnv).filter(v => v.length >= 8);
    const env = { ...process.env, ...fileEnv, DISCORD_APPLICATION_ID: (b.discord || {}).application_id || "", DISCORD_GUILD_ID: (b.discord || {}).guild_id || "", PORT: "8080" };
    delete env.RUNNER_KEY;

    if (py && has("requirements.txt")) { log(a, "info", "Instalando dependencias (pip)..."); await run(a, "pip3", ["install", "-r", "requirements.txt", "-q"], { cwd: dir, env }); }
    if (!py && has("package.json")) { log(a, "info", "Instalando dependencias (npm)..."); await run(a, "npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: dir, env }); }

    const entry = meta.entry_file || (py ? "main.py" : "index.js");
    if (!has(entry)) throw new Error("Arquivo principal '" + entry + "' nao encontrado.");
    const ram = Math.max(96, +meta.ram_mb || 256);
    const child = py ? spawn("python3", ["-u", entry], { cwd: dir, env }) : spawn("node", ["--max-old-space-size=" + (ram - 32), entry], { cwd: dir, env });
    a.child = child; a.status = "running"; a.startedAt = Date.now();
    log(a, "success", "Processo iniciado (" + (py ? "python3 " : "node ") + entry + ", pid " + child.pid + ").");
    child.stdout.on("data", d => log(a, "info", d.toString()));
    child.stderr.on("data", d => log(a, "error", d.toString()));
    child.on("error", e => log(a, "error", e.message));
    child.on("close", code => {
      a.child = null;
      log(a, code === 0 ? "info" : "error", "Processo encerrado (codigo " + code + ").");
      const t = Date.now();
      a.crashes = a.crashes.filter(x => t - x < 120000); a.crashes.push(t);
      if (a.want && a.auto && a.crashes.length <= 5) {
        a.status = "restarting"; a.restarts++;
        log(a, "warning", "Reiniciando em 5s (auto-restart)...");
        setTimeout(() => { a.status = "stopped"; if (a.want) launch(a); }, 5000);
      } else {
        if (a.want) log(a, "error", "Muitas falhas seguidas. Corrija o codigo e inicie de novo.");
        a.want = false; a.status = "stopped"; saveState();
      }
    });
  } catch (e) {
    log(a, "error", String(e.message || e));
    a.want = false; a.status = "stopped"; saveState();
  }
}
function stop(a) {
  a.want = false; saveState();
  const c = a.child;
  if (!c) { a.status = "stopped"; return; }
  c.kill("SIGTERM");
  setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 5000);
  a.status = "stopped";
}
function metrics(a) {
  return new Promise(resolve => {
    const base = { cpu_percent: 0, ram_mb: 0, uptime_seconds: a.child ? Math.floor((Date.now() - a.startedAt) / 1000) : 0, restarts: a.restarts };
    if (!a.child) return resolve(base);
    execFile("ps", ["-o", "%cpu=,rss=", "-p", String(a.child.pid)], (err, out) => {
      if (!err) { const [cpu, rss] = out.trim().split(/\s+/).map(Number); base.cpu_percent = cpu || 0; base.ram_mb = Math.round((rss || 0) / 1024); }
      resolve(base);
    });
  });
}

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.url === "/ping") { res.writeHead(200); return res.end("ok"); }
  if ((req.headers.authorization || "") !== "Bearer " + KEY) return send(res, 401, { error: "Nao autorizado." });
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") return send(res, 200, { status: "ok", provider: "botcloud-runner", version: "1.0.0", apps: apps.size });
  const m = url.pathname.match(/^\/v1\/(?:bots|apps)\/([A-Za-z0-9-]{8,64})\/(start|stop|restart|status|logs|metrics)$/);
  if (!m) return send(res, 404, { error: "Rota nao encontrada." });
  const a = getApp(m[1]), act = m[2];
  if (act === "logs") return send(res, 200, { logs: a.logs.slice(-Math.min(+url.searchParams.get("limit") || 200, 1000)) });
  if (act === "metrics") return send(res, 200, { metrics: await metrics(a) });
  if (act === "start") launch(a);
  if (act === "stop") stop(a);
  if (act === "restart") { stop(a); setTimeout(() => launch(a), 1500); a.status = "restarting"; }
  send(res, 200, { status: a.status, provider: "botcloud-runner" });
}).listen(PORT, () => {
  console.log("BoTCloud Runner na porta " + PORT);
  // religa os bots que o painel marca como "running" (hospedagem gratuita apaga o disco ao reiniciar)
  fetch(DASH + "/api/runner/running", { headers: { Authorization: "Bearer " + KEY }, signal: AbortSignal.timeout(20000) })
    .then(r => r.json()).then(j => { for (const id of j.ids || []) launch(getApp(id)); })
    .catch(() => { try { for (const id of JSON.parse(fs.readFileSync(STATE, "utf8"))) launch(getApp(id)); } catch {} });
});

process.on("SIGTERM", () => { for (const a of apps.values()) if (a.child) a.child.kill("SIGTERM"); process.exit(0); });
