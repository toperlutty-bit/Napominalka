// Рассыльщик напоминаний. Запускается GitHub Actions каждые 5 минут (.github/workflows/reminders.yml).
// Читает расписание из приватного репозитория с данными и отправляет push-уведомления
// за все минуты с прошлого успешного запуска. В логах (они публичные) — только числа, без названий лекарств.

import { GitHubStore } from "../web/js/github.js";
import { dueEvents } from "../web/js/schedule.js";
import { eventPayload } from "../web/js/core.js";
import { sendPush } from "../web/js/webpush.js";

const MINUTE = 60_000;
const MAX_WINDOW_MINUTES = 180; // если рассыльщик долго не работал — не присылаем старое

/** События с отметками минут в окне (fromMs, toMs]. Для одного приёма оставляем только самое свежее. */
export function collectEvents(state, fromMs, toMs) {
  const to = Math.floor(toMs / MINUTE);
  const from = Math.max(Math.floor(fromMs / MINUTE), to - MAX_WINDOW_MINUTES);
  const byDose = new Map();
  for (let m = from + 1; m <= to; m++) {
    for (const ev of dueEvents(state, new Date(m * MINUTE))) {
      const target = ev.kind === "missed" ? "admin" : "mom";
      byDose.set(`${target}|${ev.med.id}|${ev.day}|${ev.time}`, ev);
    }
  }
  return [...byDose.values()];
}

/** Один проход рассылки. Возвращает статистику. */
export async function runOnce({ store, fromMs, toMs, subject, send = sendPush }) {
  const { state } = await store.read();
  if (!state || !state.vapid) return { skipped: "нет данных или ключей" };
  // Для второго и следующих людей ссылка в уведомлении открывает их страницу.
  const profileQuery = store.path && store.path !== "state.json" ? `?p=${encodeURIComponent(store.path)}` : "";
  const withProfile = (payload) =>
    profileQuery && payload.url && !payload.url.includes("?") ? { ...payload, url: payload.url + profileQuery } : payload;

  const messages = [];
  for (const ev of collectEvents(state, fromMs, toMs)) {
    messages.push({ role: ev.kind === "missed" ? "admin" : "mom", payload: withProfile(eventPayload(state, ev)) });
  }
  const outboxIds = new Set();
  for (const item of state.outbox) {
    outboxIds.add(item.id);
    messages.push({ role: item.role, endpoint: item.endpoint, payload: withProfile(item.payload) });
  }

  const gone = new Set();
  let sent = 0;
  let failed = 0;
  for (const msg of messages) {
    const targets = state.subscriptions.filter((s) => (msg.endpoint ? s.subscription.endpoint === msg.endpoint : s.role === msg.role));
    const results = await Promise.allSettled(targets.map((t) => send(t.subscription, msg.payload, state.vapid, subject)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value.ok) sent++;
      else {
        failed++;
        if (r.status === "fulfilled" && r.value.gone) gone.add(targets[i].subscription.endpoint);
        console.log(`push failed: ${r.status === "fulfilled" ? r.value.status : r.reason}`);
      }
    });
  }

  if (outboxIds.size || gone.size) {
    await store.update((s) => {
      s.outbox = s.outbox.filter((o) => !outboxIds.has(o.id));
      s.subscriptions = s.subscriptions.filter((sub) => !gone.has(sub.subscription.endpoint));
    }, `Рассылка: отправлено ${sent}`);
  }
  return { messages: messages.length, sent, failed, removed: gone.size };
}

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
  let failedProfiles = 0;
  for (const [i, path] of files.entries()) {
    try {
      const stats = await runOnce({ store: base.withPath(path), fromMs, toMs, subject });
      console.log(`Человек ${i + 1} — окно ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}:`, JSON.stringify(stats));
    } catch (e) {
      failedProfiles++;
      console.log(`Человек ${i + 1}: ошибка — ${e.message}`);
      if (e.status === 404 || e.status === 401 || e.status === 403) await diagnoseToken(DATA_TOKEN, DATA_REPO);
    }
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
