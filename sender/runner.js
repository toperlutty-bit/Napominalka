// Логика рассылки (без привязки к среде): общая для Cloudflare Worker (scheduler/) и GitHub Actions (send.mjs).
// Читает расписание каждого человека и отправляет push-уведомления за минуты окна (fromMs, toMs].
// В журналы пишем только числа, без названий лекарств.

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

/** Обходит всех людей в хранилище. log — функция для журнала. */
export async function runAll({ base, fromMs, toMs, subject, send = sendPush, log = console.log }) {
  let files = await base.listProfileFiles();
  if (!files.length) files = ["state.json"];
  let failed = 0;
  const results = [];
  for (const [i, path] of files.entries()) {
    try {
      const stats = await runOnce({ store: base.withPath(path), fromMs, toMs, subject, send });
      results.push(stats);
      if (!stats.skipped && (stats.messages || stats.failed)) log(`Человек ${i + 1}: ${JSON.stringify(stats)}`);
    } catch (e) {
      failed++;
      results.push({ error: e.message });
      log(`Человек ${i + 1}: ошибка — ${e.message}`);
    }
  }
  return { profiles: files.length, failed, results };
}
