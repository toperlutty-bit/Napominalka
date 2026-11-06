// Общая логика данных: используется страницами сайта и рассыльщиком (GitHub Actions).
// Все функции чистые — работают с объектом состояния и ничего не отправляют сами.

import { localTime, dosesForDay, parseTime, formatTime, doseKey, previousDay } from "./schedule.js";

export const COLORS = ["#2f7cf6", "#22a559", "#f08c00", "#e64980", "#7950f2", "#12b5b0", "#e03131", "#495057"];
const MAX_SUBSCRIPTIONS = 20;
const MAX_MEDICINES = 30;
const MAX_OUTBOX = 50;

export function defaultSettings() {
  return {
    momName: "",
    timezone: "Europe/Moscow",
    repeatEnabled: true,
    repeatInterval: 15,
    repeatCount: 2,
    notifyMissed: true,
  };
}

export function defaultState() {
  return { version: 2, settings: defaultSettings(), medicines: [], taken: {}, subscriptions: [], outbox: [], vapid: null };
}

export function normalizeState(saved) {
  const base = defaultState();
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    settings: { ...base.settings, ...(saved.settings || {}) },
    medicines: saved.medicines || [],
    taken: saved.taken || {},
    subscriptions: saved.subscriptions || [],
    outbox: saved.outbox || [],
  };
}

/** Убирает отметки старше 60 дней. */
export function pruneState(state) {
  const days = Object.keys(state.taken || {}).sort();
  if (days.length > 60) for (const d of days.slice(0, days.length - 60)) delete state.taken[d];
  if (state.outbox.length > MAX_OUTBOX) state.outbox = state.outbox.slice(-MAX_OUTBOX);
  return state;
}

export function randomId(bytes = 9) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Как называть маму в уведомлениях родным: «Мама», «Галина Ивановна» (с заглавной буквы). */
export function momLabel(state) {
  const name = state.settings.momName?.trim() || "Мама";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function cleanString(v, max) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function weekdayOf(day) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = вс
  return wd === 0 ? 7 : wd;
}

export class ValidationError extends Error {}

// ---------- Лекарства ----------

export function validateMedicine(input, existing) {
  const name = cleanString(input.name, 80);
  if (!name) throw new ValidationError("Укажите название лекарства");
  const times = [...new Set((Array.isArray(input.times) ? input.times : []).map((t) => parseTime(t)).filter((t) => t !== null))]
    .sort((a, b) => a - b)
    .slice(0, 12)
    .map(formatTime);
  if (!times.length) throw new ValidationError("Добавьте хотя бы одно время приёма");
  let days = Array.isArray(input.days) ? [...new Set(input.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort() : [];
  if (days.length === 7) days = [];
  const color = COLORS.includes(input.color) ? input.color : existing?.color || COLORS[0];
  return {
    id: existing?.id || randomId(),
    name,
    dosage: cleanString(input.dosage, 60),
    note: cleanString(input.note, 120),
    times,
    days,
    color,
    paused: existing?.paused || false,
    pausedAt: existing?.pausedAt || null,
    pausedBy: existing?.pausedBy || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
}

export function saveMedicine(state, input) {
  const existing = input.id ? state.medicines.find((m) => m.id === input.id) : null;
  if (input.id && !existing) throw new ValidationError("Лекарство не найдено");
  if (!existing && state.medicines.length >= MAX_MEDICINES) throw new ValidationError("Слишком много лекарств");
  const med = validateMedicine(input, existing);
  if (existing) Object.assign(existing, med);
  else state.medicines.push(med);
  return med;
}

export function deleteMedicine(state, id) {
  state.medicines = state.medicines.filter((m) => m.id !== id);
}

/** «Закончились таблетки» / «Купили». Возвращает true, если лекарство только что встало на паузу. */
export function setPaused(state, medId, paused, by) {
  const med = state.medicines.find((m) => m.id === medId);
  if (!med) throw new ValidationError("Лекарство не найдено");
  const wasPaused = Boolean(med.paused);
  med.paused = Boolean(paused);
  med.pausedAt = med.paused ? med.pausedAt || new Date().toISOString() : null;
  med.pausedBy = med.paused ? by : null;
  if (med.paused && !wasPaused && by === "mom") {
    const mom = momLabel(state);
    queue(state, {
      role: "admin",
      payload: {
        title: `💊 Закончились таблетки: ${med.name}`,
        body: `${mom} отметила, что таблетки закончились. Напоминания о них на паузе, пока не нажмёте «Купили».`,
        tag: `out-${med.id}`,
        url: "./",
      },
    });
  }
  return med.paused && !wasPaused;
}

// ---------- Приёмы ----------

export function setTaken(state, medId, time, day, taken) {
  const med = state.medicines.find((m) => m.id === medId);
  if (!med || !med.times.includes(time)) throw new ValidationError("Приём не найден");
  state.taken[day] ||= {};
  if (taken) state.taken[day][doseKey(medId, time)] ||= new Date().toISOString();
  else delete state.taken[day][doseKey(medId, time)];
}

// ---------- Подписки на уведомления ----------

function b64len(s) {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)).length;
  } catch {
    return 0;
  }
}

export function validateSubscription(sub) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) throw new ValidationError("Неверная подписка");
  if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") throw new ValidationError("Неверная подписка");
  if (b64len(sub.keys.p256dh) !== 65 || b64len(sub.keys.auth) < 16) throw new ValidationError("Неверная подписка");
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

export function deviceLabel(ua = "") {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Компьютер (Windows)";
  return "Устройство";
}

export function addSubscription(state, role, rawSub, userAgent) {
  const subscription = validateSubscription(rawSub);
  const existing = state.subscriptions.find((s) => s.subscription.endpoint === subscription.endpoint);
  if (existing) {
    existing.role = role;
    existing.subscription = subscription;
    return existing;
  }
  const entry = { id: randomId(), role, label: deviceLabel(userAgent), createdAt: new Date().toISOString(), subscription };
  state.subscriptions.push(entry);
  while (state.subscriptions.filter((s) => s.role === role).length > MAX_SUBSCRIPTIONS) {
    state.subscriptions.splice(state.subscriptions.findIndex((s) => s.role === role), 1);
  }
  return entry;
}

export function removeSubscription(state, id) {
  state.subscriptions = state.subscriptions.filter((s) => s.id !== id);
}

// ---------- Очередь сообщений (отправит рассыльщик при следующем запуске) ----------

/** target: { role } — всем устройствам роли, или { endpoint } — одному устройству. */
export function queue(state, { role, endpoint, payload }) {
  state.outbox.push({ id: randomId(), role: role || null, endpoint: endpoint || null, payload, createdAt: new Date().toISOString() });
}

export function queueTest(state, { role, endpoint }) {
  queue(state, {
    role,
    endpoint,
    payload: {
      title: "✅ Проверка: всё работает!",
      body: role === "admin" ? "Уведомления для вас работают." : "Так будут приходить напоминания о таблетках.",
      tag: `test-${Date.now()}`,
      url: role === "admin" ? "./" : "./mom.html",
    },
  });
}

// ---------- Тексты напоминаний ----------

function medDetails(med) {
  return [med.dosage, med.note].filter(Boolean).join(", ");
}

export function eventPayload(state, ev) {
  const { med, time, day } = ev;
  const mom = momLabel(state);
  const details = medDetails(med);
  const tag = `dose-${med.id}-${day}-${time}`;
  if (ev.kind === "dose") {
    return { title: `💊 Пора принять: ${med.name}`, body: `${time}${details ? ` — ${details}` : ""}. Нажмите, чтобы отметить «Выпила».`, tag, url: "./mom.html" };
  }
  if (ev.kind === "repeat") {
    return { title: `⏰ Напоминаю: ${med.name}`, body: `Приём в ${time} ещё не отмечен${details ? ` (${details})` : ""}. Нажмите, чтобы отметить.`, tag, url: "./mom.html" };
  }
  return { title: `⚠️ ${mom}: приём не отмечен`, body: `${med.name} в ${time} так и не отмечен как выпитый.`, tag: `missed-${tag}`, url: "./" };
}

// ---------- Данные для страниц ----------

export function todayInfo(state, now = new Date()) {
  const t = localTime(now, state.settings.timezone);
  return { day: t.day, weekday: t.weekday, minutes: t.minutes };
}

export function todayDoses(state, now = new Date()) {
  const t = todayInfo(state, now);
  return { day: t.day, nowMinutes: t.minutes, doses: dosesForDay(state, t.day, t.weekday) };
}

export function history(state, days = 7, now = new Date()) {
  const t = todayInfo(state, now);
  const createdDay = new Map(
    state.medicines.map((m) => [m.id, m.createdAt ? localTime(new Date(m.createdAt), state.settings.timezone).day : "0000-00-00"]),
  );
  const out = [];
  let day = t.day;
  for (let i = 0; i < days; i++) {
    const doses = dosesForDay(state, day, weekdayOf(day)).filter(
      (d) => createdDay.get(d.medId) <= day && (i > 0 || parseTime(d.time) <= t.minutes),
    );
    out.push({ day, doses });
    day = previousDay(day);
  }
  return out;
}
