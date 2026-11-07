// Рассыльщик напоминаний для ручного запуска через GitHub Actions (.github/workflows/reminders.yml).
// Основной запуск — каждую минуту в Cloudflare Worker (scheduler/). В логах (они публичные) — только числа.

import { GitHubStore } from "../web/js/github.js";
import { runOnce, broadcast } from "./runner.js";

export { collectEvents, runOnce, runAll, broadcast } from "./runner.js";

const MINUTE = 60_000;

// ---------- Запуск из GitHub Actions ----------

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/** Подсказка в журнале, что не так с ключом DATA_TOKEN (без названий других репозиториев). */
async function diagnoseToken(token, repo) {
  const kind = token.startsWith("github_pat_") ? "fine-grained (github_pat_…)" : token.startsWith("ghp_") ? "classic (ghp_…)" : "неизвестный формат";
  console.log(`Диагностика ключа: тип — ${kind}, длина ${token.length}${/\s/.test(token) ? ", ЕСТЬ ПРОБЕЛЫ/ПЕРЕНОСЫ — вставьте ключ без них" : ""}.`);
  try {
    const headers = { Authorization: `Bearer ${token.trim()}`, Accept: "application/vnd.github+json" };
    const user = await fetch("https://api.github.com/user", { headers });
    console.log(`  /user: ${user.status}; scopes (для classic): ${user.headers.get("x-oauth-scopes") ?? "—"}`);
    if (user.ok) console.log(`  ключ принадлежит: ${(await user.json()).login}`);
    const res = await fetch("https://api.github.com/user/repos?per_page=100&affiliation=owner", { headers });
    if (res.ok) {
      const list = await res.json();
      const sees = list.some((r) => r.full_name.toLowerCase() === repo.toLowerCase());
      console.log(`  ключ видит репозиториев: ${list.length}, из них приватных: ${list.filter((r) => r.private).length}; ${repo}: ${sees ? "ВИДИТ" : "НЕ ВИДИТ"}`);
    } else {
      console.log(`  /user/repos: ${res.status}`);
    }
  } catch (e) {
    console.log(`  диагностика не удалась: ${e.message}`);
  }
}

async function main() {
  const { DATA_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const owner = GITHUB_REPOSITORY.split("/")[0];
  const DATA_REPO = process.env.DATA_REPO || `${owner}/napominalka-data`;
  if (!DATA_TOKEN) {
    console.log("::warning::Не задан секрет DATA_TOKEN — рассылка не настроена. См. README.");
    return;
  }

  // Окно: от начала прошлого успешного запуска до начала текущего.
  const current = await gh(`/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`);
  const toMs = Date.parse(current.run_started_at);
  const prev = await gh(`/repos/${GITHUB_REPOSITORY}/actions/workflows/${current.workflow_id}/runs?status=success&per_page=1`);
  const prevRun = prev.workflow_runs.find((r) => r.id !== current.id);
  const fromMs = prevRun ? Date.parse(prevRun.run_started_at) : toMs - 5 * MINUTE;

  const base = new GitHubStore({ token: DATA_TOKEN, repo: DATA_REPO });
  const subject = `https://${owner.toLowerCase()}.github.io`;
  let files;
  try {
    files = await base.listProfileFiles();
    if (!files.length) files = ["state.json"];
  } catch (e) {
    if (e.status === 404 || e.status === 401 || e.status === 403) await diagnoseToken(DATA_TOKEN, DATA_REPO);
    throw e;
  }
  // Если будильник в Cloudflare уже работает — обычную рассылку делает он (чтобы не было дублей).
  let cloudflareActive = false;
  try {
    const res = await fetch(process.env.SCHEDULER_STATUS_URL || "https://napominalka.napominalka-tabletok.workers.dev/status", { signal: AbortSignal.timeout(10_000) });
    const st = res.ok ? await res.json() : {};
    cloudflareActive = Boolean(st.tokenSet && st.dataOk);
  } catch {}
  if (cloudflareActive) console.log("Будильник Cloudflare работает — обычную рассылку делает он.");

  let failedProfiles = 0;
  for (const [i, path] of (cloudflareActive ? [] : files).entries()) {
    try {
      const stats = await runOnce({ store: base.withPath(path), fromMs, toMs, subject });
      console.log(`Человек ${i + 1} — окно ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}:`, JSON.stringify(stats));
    } catch (e) {
      failedProfiles++;
      console.log(`Человек ${i + 1}: ошибка — ${e.message}`);
      if (e.status === 404 || e.status === 401 || e.status === 403) await diagnoseToken(DATA_TOKEN, DATA_REPO);
    }
  }
  // Сообщение всем (ручной запуск с заполненным полем «message»).
  const message = (process.env.BROADCAST_MESSAGE || "").trim();
  if (message) {
    const title = (process.env.BROADCAST_TITLE || "").trim() || "🔔 Напоминалка";
    const r = await broadcast({ base, payload: { title, body: message, tag: `broadcast-${Date.now()}` }, subject });
    console.log(`Сообщение всем: ${JSON.stringify(r)}`);
  }

  if (failedProfiles) throw new Error(`Не удалось обработать: ${failedProfiles} из ${files.length}`);

  // Раз в сутки не даём GitHub выключить расписание из-за «неактивности» репозитория.
  if (new Date(toMs).getUTCHours() === 3 && new Date(toMs).getUTCMinutes() < 10) {
    await gh(`/repos/${GITHUB_REPOSITORY}/actions/workflows/${current.workflow_id}/enable`, { method: "PUT" }).catch((e) => console.log(String(e)));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
