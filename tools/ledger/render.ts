#!/usr/bin/env bun
/**
 * render.ts — regenerates every number in README.md from primary sources, then rewrites it.
 *
 *   bun tools/ledger/render.ts            # rewrite README.md
 *   bun tools/ledger/render.ts --check    # render to stdout-hash only, exit 1 if README.md differs
 *   bun tools/ledger/render.ts --rows     # print the parsed revenue-tree rows (id, class, status)
 *
 * Determinism: every source is cut at AS_OF (00:00Z, exclusive) from ledger.config.json, so two runs
 * on the same day print the same bytes even while new sessions keep writing. Moving AS_OF is the
 * only way the numbers move.
 *
 * The primary sources live in Pico's private workspace (PICO_WORKSPACE, default /workspace). Each
 * metric carries `cmd`: an independent command that reproduces it, so a reader with the same files
 * does not have to trust this script.
 *
 * Also renders data/drafts/*.md into drafts/ with the same numbers.
 *
 * Fails LOUD (exit 2, nothing written) on: a missing source, a parse floor not met, a "what I did
 * wrong" entry whose quoted evidence is absent from its source file, or any private term in the output.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";

const REPO = join(dirname(import.meta.path), "..", "..");
const WS = process.env.PICO_WORKSPACE ?? "/workspace";
const cfg = JSON.parse(readFileSync(join(REPO, "ledger.config.json"), "utf8"));
const AS_OF: string = cfg.asOf; // YYYY-MM-DD, exclusive
const PI_START: string = cfg.piEraStart;
const args = new Set(process.argv.slice(2));

function die(msg: string): never { console.error(`render: FAIL — ${msg}`); process.exit(2); }
function need(path: string): string { if (!existsSync(path)) die(`source missing: ${path}`); return path; }
const day = (s: string) => String(s).slice(0, 10);
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0) + "%";
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

type Metric = { key: string; label: string; value: string; cmd: string };
const M: Record<string, Metric> = {};
function metric(key: string, label: string, value: string | number, cmd: string) {
  M[key] = { key, label, value: String(value), cmd };
  return String(value);
}

// ── 1. Revenue ───────────────────────────────────────────────────────────────
const LEDGER = need(join(WS, "money/invoices/ledger.json"));
const inv: any[] = JSON.parse(readFileSync(LEDGER, "utf8"));
if (!Array.isArray(inv) || inv.length === 0) die("ledger.json parsed to 0 invoices");
const ext = inv.filter((i) => i.internal !== true && i.paymentReceived === true && day(i.paymentDate) < AS_OF);
const internal = inv.filter((i) => i.internal === true);
const extUSD = ext.reduce((s, i) => s + Number(i.amountEstimateUSD ?? NaN), 0);
if (!Number.isFinite(extUSD)) die("an external invoice lacks amountEstimateUSD");
const lastPaid = ext.map((i) => day(i.paymentDate)).sort().at(-1) ?? "never";
metric("rev", "External revenue, lifetime", usd(extUSD),
  `jq '[.[]|select(.internal!=true and .paymentReceived==true)|.amountEstimateUSD]|add' money/invoices/ledger.json`);
metric("rev_n", "Paying external customers", ext.length,
  `jq '[.[]|select(.internal!=true and .paymentReceived==true)]|length' money/invoices/ledger.json`);
metric("rev_last", "Last external payment", lastPaid,
  `jq -r '[.[]|select(.internal!=true and .paymentReceived==true)|.paymentDate]|max' money/invoices/ledger.json`);
metric("rev_dry", "Days since that payment (to as-of)", daysBetween(lastPaid, AS_OF), `echo $(( ($(date -d ${AS_OF} +%s) - $(date -d ${lastPaid} +%s)) / 86400 ))`);
metric("rev_internal", "Invoices excluded as related-party", internal.length,
  `jq '[.[]|select(.internal==true)]|length' money/invoices/ledger.json`);

// ── 2. Token spend (pi era: every message is priced by the runtime itself) ──────
const SESS = need(join(process.env.HOME ?? "/home/bun", ".pi/agent/sessions/--workspace--"));
const seen = new Set<string>();
const perDay = new Map<string, number>();
let piCost = 0, piMsgs = 0, unpriced = 0, parsedLines = 0;
const sessFiles = readdirSync(SESS).filter((f) => f.endsWith(".jsonl") && f.slice(0, 10) < AS_OF);
const sessInWindow = new Set<string>();
for (const f of sessFiles) {
  for (const line of readFileSync(join(SESS, f), "utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    const ts = String(d.timestamp ?? ""); const m = d.message;
    if (!m?.usage || day(ts) < PI_START || day(ts) >= AS_OF) continue;
    parsedLines++;
    const id = m.responseId ?? m.id ?? f + ts;
    if (seen.has(id)) continue; seen.add(id);
    const c = m.usage.cost?.total;
    if (typeof c !== "number") { unpriced++; continue; }
    piCost += c; piMsgs++; sessInWindow.add(f);
    perDay.set(day(ts), (perDay.get(day(ts)) ?? 0) + c);
  }
}
if (piMsgs < 1000) die(`token floor: only ${piMsgs} priced messages parsed (expected >1000)`);
const piDays = daysBetween(PI_START, AS_OF);
const daysWithSpend = perDay.size;
const perDayAvg = piCost / piDays;
const maxDay = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
metric("tok", `Token spend at list price, ${PI_START} → ${AS_OF}`, usd(piCost),
  `python3 tools/burn-meter.py <day> --json  # per day, summed; field harness_usd_total (dedup by responseId)`);
metric("tok_days", "Days in that window", piDays, `echo ${piDays}`);
metric("tok_live", "…of which I ran at all", daysWithSpend, `count of days with ≥1 priced call (the rest: host outage, 0 sessions, 0 reflections)`);
metric("tok_avg", "Average per day", usd(perDayAvg), `tok / tok_days`);
metric("tok_max", "Most expensive day", `${usd(maxDay[1])} (${maxDay[0]})`, `python3 tools/burn-meter.py ${maxDay[0]}`);
metric("tok_msgs", "Model calls priced", piMsgs.toLocaleString("en-US"), `same scan, count of deduped assistant messages with usage.cost.total`);
metric("sessions", "Sessions run in that window", sessInWindow.size.toLocaleString("en-US"),
  `ls ~/.pi/agent/sessions/--workspace--/*.jsonl | awk -F/ '$NF >= "${PI_START}" && $NF < "${AS_OF}"' | wc -l  # minus files with no priced call`);
metric("sess_day", "Sessions per day I ran", Math.round(sessInWindow.size / daysWithSpend), `sessions / tok_live`);
if (unpriced) console.error(`render: note — ${unpriced} messages had usage but no cost.total (excluded)`);

// Pre-pi gap: first logged activity → PI_START, no transcripts on this volume.
const SENT = need(join(WS, ".state/sent-emails.jsonl"));
const sentRows: any[] = [];
for (const l of readFileSync(SENT, "utf8").split("\n")) { if (!l.trim()) continue; try { sentRows.push(JSON.parse(l)); } catch {} }
if (sentRows.length < 100) die(`sent log floor: ${sentRows.length} rows parsed`);
const sentDate = (r: any) => { const t = Date.parse(r.date ?? r.timestamp ?? ""); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };
const firstDay = sentRows.map(sentDate).filter(Boolean).sort()[0] as string;
const prePiDays = daysBetween(firstDay, PI_START);
metric("first", "First logged action", firstDay, `head -1 .state/sent-emails.jsonl | jq -r .date`);
const months = Math.round((daysBetween(firstDay, AS_OF) / 30.44) * 2) / 2;
metric("months", "Months since the first logged action (to the nearest half)", months, `days ${firstDay} → ${AS_OF} / 30.44`);
metric("months_no", "Same, Norwegian decimal", String(months).replace(".", ","), `months`);
metric("prepi_days", "Days before per-call pricing existed", prePiDays, `days ${firstDay} → ${PI_START}`);
metric("prepi_est", "Pre-pi spend if it ran at the pi-era daily average (estimate, not a measurement)", usd(perDayAvg * prePiDays), `tok_avg × prepi_days`);

// ── 3. Email ─────────────────────────────────────────────────────────────────
const priv = existsSync(join(WS, ".state/ledger-private.json")) ? JSON.parse(readFileSync(join(WS, ".state/ledger-private.json"), "utf8")) : die("private config missing");
const related: string[] = priv.related_recipient_patterns.map((s: string) => s.toLowerCase());
let sentExt = 0, sentRel = 0; const extDomains = new Set<string>();
for (const r of sentRows) {
  const d = sentDate(r); if (!d || d >= AS_OF) continue;
  const to = (Array.isArray(r.to) ? r.to.join(",") : String(r.to ?? "")).toLowerCase();
  if (!to) continue;
  if (related.some((p) => to.includes(p))) { sentRel++; continue; }
  sentExt++; extDomains.add(to.split("@").pop()!.replace(/[>\s].*$/, ""));
}
metric("mail", "Emails sent outside my operator's circle", sentExt.toLocaleString("en-US"),
  `jq -r .to .state/sent-emails.jsonl | grep -viE '<related-party patterns>' | wc -l`);
metric("mail_dom", "Distinct recipient domains", extDomains.size, `same, | awk -F@ '{print $NF}' | sort -u | wc -l`);
metric("mail_rel", "Sends excluded (operator, his family and companies, myself)", sentRel, `same, grep -ciE '<related-party patterns>'`);

// ── 4. Graveyard: the revenue tree's branch registry ────────────────────────────
const TREE = need(join(WS, "memory/knowledge/revenue-exploration-tree.md"));
const treeLines = readFileSync(TREE, "utf8").split("\n");
const ROW = /^\|\s*((?:B|M)\d+(?:-[A-Z]+)?)\s*\|/;
type Row = { id: string; status: string; klass: string };
const rows: Row[] = [];
for (const l of treeLines) {
  const m = l.match(ROW); if (!m) continue;
  const cells = l.split(/(?<!\\)\|/).map((c) => c.trim()); // escaped \| inside a cell is not a column break (B49 row)
  // | ID | Branch | Physics | Phase-1 task | Status | Verdict evidence |
  const status = cells[5] ?? "";
  rows.push({ id: m[1], status, klass: classify(status) });
}
function classify(s: string): string {
  const t = s.replace(/\*/g, "");
  if (/\bPARKED\b|\bPARKERT\b/.test(t)) return "parked";
  if (/^LIVE\b/.test(t)) return "live";
  if (/\bDVALE\b/.test(t)) return "dormant";
  if (/PROMISING/.test(t)) return "weak-open";
  if (/GRANT-INSTRUMENTAL/.test(t)) return "harvest-only";
  if (/^DONE\b/.test(t)) return "done (meta)";
  if (/LUKKET UTESTET/.test(t)) return "closed untested";
  if (/DEAD|DØD|NO-GO/.test(t)) return "dead";
  if (/^GO\b/.test(t)) return "go";
  return "unclassified";
}
if (rows.length < 40) die(`tree floor: ${rows.length} registry rows parsed`);
if (new Set(rows.map((r) => r.id)).size !== rows.length) die("duplicate branch IDs in registry");
const uncl = rows.filter((r) => r.klass === "unclassified"); if (uncl.length && !args.has("--rows")) die(`status not classifiable for: ${uncl.map((r) => r.id).join(", ")}`);
if (args.has("--rows")) { for (const r of rows) console.log(r.id.padEnd(9), r.klass.padEnd(13), r.status.slice(0, 110)); process.exit(0); }
const G = JSON.parse(readFileSync(join(REPO, "data/graveyard.json"), "utf8"));
const missing = rows.filter((r) => !G[r.id]).map((r) => r.id);
const orphan = Object.keys(G).filter((k) => !k.startsWith("_") && !rows.some((r) => r.id === k));
if (missing.length) die(`graveyard.json lacks a line for: ${missing.join(", ")}`);
if (orphan.length) die(`graveyard.json has lines for rows no longer in the tree: ${orphan.join(", ")}`);
const byClass = new Map<string, number>(); for (const r of rows) byClass.set(r.klass, (byClass.get(r.klass) ?? 0) + 1);
const dead = byClass.get("dead") ?? 0;
metric("tree", "Revenue branches opened (registry rows)", rows.length,
  `grep -cE '^\\|\\s*(B|M)[0-9]+(-[A-Z]+)?\\s*\\|' memory/knowledge/revenue-exploration-tree.md`);
metric("tree_dead", "…of which dead (DEAD / DØD / NO-GO)", dead, `bun tools/ledger/render.ts --rows | awk '$2=="dead"' | wc -l`);

// ── 5. Calibration + memory (Turso) ─────────────────────────────────────────────
for (const k of ["TURSO_URL", "TURSO_AUTH_TOKEN"]) if (!process.env[k]) die(`${k} not set (source .secrets/turso.env)`);
const db = createClient({ url: process.env.TURSO_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
const P = (await db.execute({
  sql: `SELECT technique, status, brier_score, resolved_at, confidence FROM predictions WHERE substr(created_at,1,10) < ?`, args: [AS_OF],
})).rows as any[];
if (P.length < 1000) die(`prediction floor: ${P.length} rows`);
const resolvedBy = (p: any) => p.resolved_at && day(p.resolved_at) < AS_OF;
function stats(ps: any[]) {
  const res = ps.filter((p) => ["correct", "wrong", "partial"].includes(p.status) && resolvedBy(p));
  const ok = res.filter((p) => p.status === "correct").length;
  const br = ps.filter((p) => ["correct", "wrong"].includes(p.status) && resolvedBy(p) && p.brier_score != null).map((p) => Number(p.brier_score));
  return { total: ps.length, resolved: res.length, correct: ok, brier: br.length ? br.reduce((a, b) => a + b, 0) / br.length : NaN };
}
const all = stats(P), cold = stats(P.filter((p) => p.technique === "cold-email-outreach"));
const EMAIL = new Set(["cold-email-outreach", "email-followup"]);
const nonEmail = stats(P.filter((p) => !EMAIL.has(p.technique)));
const unmeas = P.filter((p) => p.status === "unmeasurable" && resolvedBy(p)).length; // as-of cut on resolution too, or this row drifts after the cut (300 -> 302 on 10-12)
metric("pred", "Predictions filed (each with a metric query that resolves it)", all.total.toLocaleString("en-US"),
  `SELECT count(*) FROM predictions WHERE substr(created_at,1,10) < '${AS_OF}'`);
metric("pred_acc", "Resolved / correct", `${all.resolved.toLocaleString("en-US")} / ${all.correct.toLocaleString("en-US")} (${pct(all.correct, all.resolved)})`,
  `bun tools/pico-db/prediction-stats.ts  # 'Overall' line; this script also cuts at resolved_at < as-of`);
metric("pred_ok_of", "Correct out of resolved, as prose", `${all.correct.toLocaleString("en-US")} of ${all.resolved.toLocaleString("en-US")} (${pct(all.correct, all.resolved)})`, `pred_acc`);
metric("cold_ok_of", "Cold-email correct out of resolved, as prose", `${cold.correct} of ${cold.resolved} (${pct(cold.correct, cold.resolved)})`, `cold`);
metric("brier", "Brier score (0 = perfect, 0.25 = coin flip at 50%)", all.brier.toFixed(3), `same, 'weighted brier'`);
metric("brier_ex", "Brier score without the two email techniques", nonEmail.brier.toFixed(3),
  `same query, WHERE technique NOT IN ('cold-email-outreach','email-followup')`);
metric("pred_unmeas", "Predictions I could not measure at all", `${unmeas} (${pct(unmeas, all.total)})`, `SELECT count(*) FROM predictions WHERE status='unmeasurable' AND substr(created_at,1,10) < '${AS_OF}' AND substr(resolved_at,1,10) < '${AS_OF}'`);
const coldConf = (() => { const c = P.filter((p) => p.technique === "cold-email-outreach" && p.confidence != null).map((p) => Number(p.confidence)); return c.reduce((a, b) => a + b, 0) / c.length; })();
metric("cold_conf", "Average confidence on those cold-email predictions", Math.round(coldConf * 100) + "%", `bun tools/pico-db/prediction-stats.ts | grep cold-email-outreach  # avgConf`);
metric("cold", "Cold-email predictions / correct", `${cold.total} / ${cold.correct} of ${cold.resolved} resolved (${pct(cold.correct, cold.resolved)})`,
  `bun tools/pico-db/prediction-stats.ts | grep cold-email-outreach`);
const one = async (sql: string) => Number(((await db.execute({ sql, args: [AS_OF] })).rows[0] as any).c);
const nRefl = await one(`SELECT count(*) c FROM reflections WHERE substr(created_at,1,10) < ?`);
const nTasks = await one(`SELECT count(*) c FROM tasks WHERE substr(created_at,1,10) < ?`);
metric("refl", "Post-task reflections written", nRefl.toLocaleString("en-US"), `SELECT count(*) FROM reflections WHERE substr(created_at,1,10) < '${AS_OF}'`);
metric("tasks", "Tasks created in my queue", nTasks.toLocaleString("en-US"), `SELECT count(*) FROM tasks WHERE substr(created_at,1,10) < '${AS_OF}'`);

// ── 5b. Human attention: stars on my public repos from anyone but my operator and me ──
const STAR_FROM = cfg.agentFirstStart; // the day the direction became "agents first, attention before money"
async function gh(path: string, star = false): Promise<any> {
  const a = star ? ["api", "-H", "Accept: application/vnd.github.star+json", path] : ["api", path];
  const r = Bun.spawnSync(["gh", ...a]);
  if (r.exitCode !== 0) die(`gh api ${path} -> ${r.exitCode} ${r.stderr.toString().slice(0, 200)}`);
  return JSON.parse(r.stdout.toString());
}
const repos: any[] = [];
for (let page = 1; page <= 10; page++) { const b = await gh(`users/piiiico/repos?per_page=100&page=${page}&type=owner`); repos.push(...b); if (b.length < 100) break; }
if (repos.length < 10) die(`repo floor: ${repos.length} repos listed`);
let starsWindow = 0, starsEver = 0;
for (const r of repos) {
  if (!r.stargazers_count) continue;
  for (let page = 1; page <= 10; page++) {
    const s: any[] = await gh(`repos/${r.full_name}/stargazers?per_page=100&page=${page}`, true);
    for (const x of s) {
      const login = String(x.user?.login ?? "").toLowerCase();
      if (login === "hawkaa" || login === "piiiico") continue;
      const d = day(x.starred_at); if (d >= AS_OF) continue;
      starsEver++; if (d >= STAR_FROM) starsWindow++;
    }
    if (s.length < 100) break;
  }
}
metric("repos", "Public repos I own", repos.filter((r) => !r.private).length, `gh api users/piiiico/repos --paginate | jq length`);
metric("stars_win", `GitHub stars from strangers, ${STAR_FROM} → ${AS_OF}`, starsWindow, `SINCE=${STAR_FROM}T00:00:00Z bun tools/prediction-queries/course-1011-human-stars.ts  # excludes my operator and me`);
metric("stars_ever", "…and ever, before the cut-off", starsEver, `SINCE=2020-01-01T00:00:00Z bun tools/prediction-queries/course-1011-human-stars.ts`);

// ── 6. What I did wrong — every entry must still be findable in its source ─────
const W: any[] = JSON.parse(readFileSync(join(REPO, "data/wrong.json"), "utf8"));
for (const w of W) {
  const src = join(WS, w.source);
  if (!existsSync(src)) die(`wrong.json ${w.date}: source missing ${w.source}`);
  if (!readFileSync(src, "utf8").includes(w.needle)) die(`wrong.json ${w.date}: evidence string not found in ${w.source}: ${w.needle}`);
}
metric("wrong", "Real-world mistakes listed below, each re-checked against its source on this run", W.length, `bun tools/ledger/render.ts  # exits 2 if any evidence string is gone`);

// ── Render ─────────────────────────────────────────────────────────────────────
const tpl = readFileSync(join(REPO, "data/README.template.md"), "utf8");
const graveTable = ["| ID | Branch | Status | Why it died (or why it hasn't) |", "|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${G[r.id].name} | ${r.klass} | ${G[r.id].why} |`)].join("\n");
const classLine = [...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(" · ");
const wrongList = W.map((w) => `- **${w.date}: ${w.title}** ${w.what}\n  <sub>Source: \`${w.source}\`. Who caught it: ${w.caught}.</sub>`).join("\n");
const numTable = ["| # | Number | Value | Command |", "|---|---|---|---|",
  ...Object.values(M).map((m, i) => `| ${i + 1} | ${m.label} | **${m.value}** | \`${m.cmd.replace(/\|/g, "\\|")}\` |`)].join("\n");
const fill = (t: string) => t.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => (M[k] ? M[k].value : die(`template references unknown metric {{${k}}}`))).replace(/<!--AS_OF-->/g, AS_OF);
let out = fill(tpl)
  .replace("<!--GRAVEYARD-->", graveTable).replace("<!--CLASSES-->", classLine)
  .replace("<!--WRONG-->", wrongList).replace("<!--NUMBERS-->", numTable)
  .replace(/<!--AS_OF-->/g, AS_OF);

// Drafts are templates too (data/drafts/*.md -> drafts/*.md), so a number cannot fork between the page and the post.
const tplDir = join(REPO, "data/drafts");
const drafts: [string, string][] = existsSync(tplDir) ? readdirSync(tplDir).filter((f) => f.endsWith(".md")).sort().map((f) => [`drafts/${f}`, fill(readFileSync(join(tplDir, f), "utf8"))]) : [];
// Private-term gate: README + every draft, rendered. A hit means the artifact would leak; nothing is written.
const deny: string[] = priv.deny_terms;
const numbers = JSON.stringify({ asOf: AS_OF, numbers: Object.values(M) }, null, 2) + "\n";
const surfaces: [string, string][] = [["README.md", out], ["numbers.json", numbers], ...drafts];
// Whole-word match: a substring test flags "Selling" for a name inside it (measured on the first run).
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Terms with digits are identifier PREFIXES (wallets, tx hashes, org numbers): those stay substring.
const hit = (s: string, t: string) => /\d/.test(t) ? s.toLowerCase().includes(t.toLowerCase()) : new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}(?![\\p{L}\\p{N}])`, "iu").test(s);
const leaks = surfaces.flatMap(([n, s]) => deny.filter((t) => hit(s, t)).map((t) => `${n}: "${t}"`));
if (deny.length < 10) die("deny list floor not met");
if (leaks.length) die(`private terms in output:\n  ${leaks.join("\n  ")}`);

const hash = createHash("sha256").update(surfaces.map(([n, s]) => n + "\0" + s).join("\0")).digest("hex").slice(0, 16);
if (args.has("--check")) {
  const stale = surfaces.filter(([n, s]) => !existsSync(join(REPO, n)) || readFileSync(join(REPO, n), "utf8") !== s).map(([n]) => n);
  console.log(`render sha256:${hash} ${stale.length ? "STALE: " + stale.join(", ") : "== all " + surfaces.length + " files on disk"}`);
  process.exit(stale.length ? 1 : 0);
}
mkdirSync(join(REPO, "drafts"), { recursive: true });
for (const [n, s] of surfaces) writeFileSync(join(REPO, n), s);
console.log(`render: wrote ${surfaces.length} files sha256:${hash} (${Object.keys(M).length} numbers, ${rows.length} branches, ${W.length} mistakes, as-of ${AS_OF})`);
