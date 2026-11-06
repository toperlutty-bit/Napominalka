// Напоминалка — сайт, который сам присылает маме push-уведомления о таблетках.
// Работает на Cloudflare Workers: страницы + API + запуск по расписанию каждую минуту.

import { generateVapidKeys, sendPush, b64urlEncode, b64urlDecode } from "./webpush.js";
import { dueEvents, localTime, dosesForDay, isValidTimeZone, parseTime, formatTime, doseKey, previousDay } from "./schedule.js";

const STATE_KEY = "state";
const SESSION_COOKIE = "nap_session";
const SESSION_DAYS = 90;
const MAX_SUBSCRIPTIONS = 20;
const MAX_MEDICINES = 30;
const COLORS = ["#2f7cf6", "#22a559", "#f08c00", "#e64980", "#7950f2", "#12b5b0", "#e03131", "#495057"];

const enc = new TextEncoder();

// ---------- Хранилище ----------

function defaultSettings() {
  return {
    momName: "",
    timezone: "Europe/Moscow",
    repeatEnabled: true,
    repeatInterval: 15,
    repeatCount: 2,
    notifyMissed: true,
  };
}

function defaultState() {
  return {
    version: 1,
    settings: defaultSettings(),
    medicines: [],
    taken: {},
    subscriptions: [],
    auth: null,
    momToken: null,
    sessionSecret: null,
    vapid: null,
    origin: null,
  };
}

async function loadState(env) {
  const saved = await env.DB.get(STATE_KEY, "json");
  if (!saved) return defaultState();
  return { ...defaultState(), ...saved, settings: { ...defaultSettings(), ...(saved.settings || {}) } };
}

async function saveState(env, state) {
  // Храним отметки о приёме за 60 дней.
  const days = Object.keys(state.taken || {}).sort();
  if (days.length > 60) {
    for (const d of days.slice(0, days.length - 60)) delete state.taken[d];
  }
  await env.DB.put(STATE_KEY, JSON.stringify(state));
}

// ---------- Утилиты ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function randomToken(bytes = 24) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) throw new HttpError("Ожидается JSON", 415);
  const text = await request.text();
  if (text.length > 20000) throw new HttpError("Слишком большой запрос", 413);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new HttpError("Неверный JSON", 400);
  }
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64urlDecode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return { salt: b64urlEncode(salt), hash: b64urlEncode(new Uint8Array(bits)) };
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}

async function makeSessionCookie(state) {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  const sig = await hmac(state.sessionSecret, `admin|${exp}|${state.auth.hash}`);
  return `${SESSION_COOKIE}=${exp}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

async function isAdmin(request, state) {
  if (!state.auth || !state.sessionSecret) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=(\\d+)\\.([A-Za-z0-9_-]+)`).exec(cookie);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > Date.now())) return false;
  const expected = await hmac(state.sessionSecret, `admin|${exp}|${state.auth.hash}`);
  return safeEqual(expected, m[2]);
}

function weekdayOf(day) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = вс
  return wd === 0 ? 7 : wd;
}

function deviceLabel(ua = "") {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Компьютер (Windows)";
  return "Устройство";
}

function momUrl(state) {
  return state.origin && state.momToken ? `${state.origin}/m/${state.momToken}` : null;
}

// ---------- Push ----------

/** Отправляет уведомление всем устройствам с ролью role. Удаляет подписки, которые больше не действуют. */
async function pushToRole(state, role, payload) {
  const targets = state.subscriptions.filter((s) => s.role === role);
  if (!targets.length || !state.vapid) return { sent: 0, failed: 0, total: 0, changed: false };
  const subject = state.origin || "https://napominalka.workers.dev";
  const results = await Promise.allSettled(targets.map((t) => sendPush(t.subscription, payload, state.vapid, subject)));
  let sent = 0;
  let failed = 0;
  const gone = new Set();
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.ok) {
      sent++;
    } else {
      failed++;
      if (r.status === "fulfilled" && r.value.gone) gone.add(targets[i].id);
      console.log("push failed", targets[i].id, r.status === "fulfilled" ? `${r.value.status} ${r.value.text}` : String(r.reason));
    }
  });
  if (gone.size) state.subscriptions = state.subscriptions.filter((s) => !gone.has(s.id));
  return { sent, failed, total: targets.length, changed: gone.size > 0 };
}

function medDetails(med) {
  return [med.dosage, med.note].filter(Boolean).join(", ");
}

function eventPayload(state, ev) {
  const { med, time, day } = ev;
  const mom = state.settings.momName?.trim() || "Мама";
  const details = medDetails(med);
  const tag = `dose-${med.id}-${day}-${time}`;
  const url = state.momToken ? `/m/${state.momToken}` : "/";
  if (ev.kind === "dose") {
    return {
      title: `💊 Пора принять: ${med.name}`,
      body: `${time}${details ? ` — ${details}` : ""}. Нажмите, чтобы отметить «Выпила».`,
      tag,
      url,
    };
  }
  if (ev.kind === "repeat") {
    return {
      title: `⏰ Напоминаю: ${med.name}`,
      body: `Приём в ${time} ещё не отмечен${details ? ` (${details})` : ""}. Нажмите, чтобы отметить.`,
      tag,
      url,
    };
  }
  return {
    title: `⚠️ ${mom}: приём не отмечен`,
    body: `${med.name} в ${time} так и не отмечен как выпитый.`,
    tag: `missed-${tag}`,
    url: "/admin",
  };
}

/** Запускается каждую минуту. */
export async function runSchedule(env, date) {
  const state = await loadState(env);
  if (!state.vapid) return { events: 0 };
  const events = dueEvents(state, date);
  let changed = false;
  for (const ev of events) {
    const role = ev.kind === "missed" ? "admin" : "mom";
    const r = await pushToRole(state, role, eventPayload(state, ev));
    changed ||= r.changed;
  }
  if (changed) await saveState(env, state);
  return { events: events.length };
}

// ---------- Проверка данных ----------

function cleanString(v, max) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function validateMedicine(input, existing) {
  const name = cleanString(input.name, 80);
  if (!name) throw new HttpError("Укажите название лекарства", 400);
  const times = [...new Set((Array.isArray(input.times) ? input.times : []).map((t) => parseTime(t)).filter((t) => t !== null))]
    .sort((a, b) => a - b)
    .slice(0, 12)
    .map(formatTime);
  if (!times.length) throw new HttpError("Добавьте хотя бы одно время приёма", 400);
  let days = Array.isArray(input.days) ? [...new Set(input.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort() : [];
  if (days.length === 7) days = [];
  const color = COLORS.includes(input.color) ? input.color : existing?.color || COLORS[0];
  return {
    id: existing?.id || randomToken(9),
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

function validateSubscription(sub) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) throw new HttpError("Неверная подписка", 400);
  if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") throw new HttpError("Неверная подписка", 400);
  if (b64urlDecode(sub.keys.p256dh).length !== 65 || b64urlDecode(sub.keys.auth).length < 16) throw new HttpError("Неверная подписка", 400);
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

function addSubscription(state, role, rawSub, request) {
  const subscription = validateSubscription(rawSub);
  const existing = state.subscriptions.find((s) => s.subscription.endpoint === subscription.endpoint);
  if (existing) {
    existing.role = role;
    existing.subscription = subscription;
    return existing;
  }
  const entry = {
    id: randomToken(9),
    role,
    label: deviceLabel(request.headers.get("User-Agent") || ""),
    createdAt: new Date().toISOString(),
    subscription,
  };
  state.subscriptions.push(entry);
  // Ограничиваем количество: удаляем самые старые этой роли.
  while (state.subscriptions.filter((s) => s.role === role).length > MAX_SUBSCRIPTIONS) {
    const idx = state.subscriptions.findIndex((s) => s.role === role);
    state.subscriptions.splice(idx, 1);
  }
  return entry;
}

function setPaused(state, med, paused, by) {
  med.paused = Boolean(paused);
  med.pausedAt = med.paused ? new Date().toISOString() : null;
  med.pausedBy = med.paused ? by : null;
}

// ---------- Данные для страниц ----------

function todayInfo(state) {
  const now = localTime(new Date(), state.settings.timezone);
  return { day: now.day, weekday: now.weekday, minutes: now.minutes };
}

function momView(state) {
  const t = todayInfo(state);
  return {
    momName: state.settings.momName,
    timezone: state.settings.timezone,
    day: t.day,
    nowMinutes: t.minutes,
    doses: dosesForDay(state, t.day, t.weekday),
    vapidPublicKey: state.vapid?.publicKey || null,
  };
}

function adminView(state) {
  const t = todayInfo(state);
  // День, когда лекарство добавили (в часовом поясе мамы): раньше него приёмы в истории не показываем.
  const createdDay = new Map(
    state.medicines.map((m) => [m.id, m.createdAt ? localTime(new Date(m.createdAt), state.settings.timezone).day : "0000-00-00"]),
  );
  const history = [];
  let day = t.day;
  for (let i = 0; i < 7; i++) {
    const doses = dosesForDay(state, day, weekdayOf(day)).filter(
      (d) => createdDay.get(d.medId) <= day && (i > 0 || parseTime(d.time) <= t.minutes),
    );
    history.push({ day, doses });
    day = previousDay(day);
  }
  return {
    settings: state.settings,
    medicines: state.medicines,
    colors: COLORS,
    today: { day: t.day, nowMinutes: t.minutes, doses: dosesForDay(state, t.day, t.weekday) },
    history,
    momUrl: momUrl(state),
    vapidPublicKey: state.vapid?.publicKey || null,
    subscriptions: state.subscriptions.map((s) => ({
      id: s.id,
      role: s.role,
      label: s.label,
      createdAt: s.createdAt,
      host: new URL(s.subscription.endpoint).host,
    })),
  };
}

// ---------- Маршруты ----------

async function serveAsset(env, request, path, replacements) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  if (!replacements) return res;
  let text = await res.text();
  for (const [k, v] of Object.entries(replacements)) text = text.split(k).join(v);
  return new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function handleMomApi(request, env, state, token, action) {
  if (!state.momToken || !safeEqual(token, state.momToken)) return error("Ссылка недействительна", 404);
  if (action === "today" && request.method === "GET") return json(momView(state));
  if (request.method !== "POST") return error("Метод не поддерживается", 405);
  const body = await readJson(request);

  if (action === "subscribe") {
    addSubscription(state, "mom", body.subscription, request);
    await saveState(env, state);
    return json({ ok: true });
  }

  if (action === "taken") {
    const med = state.medicines.find((m) => m.id === body.medId);
    if (!med || !med.times.includes(body.time)) return error("Приём не найден", 404);
    const day = todayInfo(state).day;
    const allowedDays = [day, previousDay(day)];
    const targetDay = allowedDays.includes(body.day) ? body.day : day;
    state.taken[targetDay] ||= {};
    if (body.undo) delete state.taken[targetDay][doseKey(med.id, body.time)];
    else state.taken[targetDay][doseKey(med.id, body.time)] ||= new Date().toISOString();
    await saveState(env, state);
    return json(momView(state));
  }

  if (action === "pause") {
    const med = state.medicines.find((m) => m.id === body.medId);
    if (!med) return error("Лекарство не найдено", 404);
    const wasPaused = med.paused;
    setPaused(state, med, body.paused, "mom");
    if (med.paused && !wasPaused) {
      const mom = state.settings.momName?.trim() || "Мама";
      await pushToRole(state, "admin", {
        title: `💊 Закончились таблетки: ${med.name}`,
        body: `${mom} отметила, что таблетки закончились. Напоминания о них на паузе, пока не нажмёте «Купили».`,
        tag: `out-${med.id}`,
        url: "/admin",
      });
    }
    await saveState(env, state);
    return json(momView(state));
  }

  return error("Не найдено", 404);
}

async function handleAdminApi(request, env, state, path) {
  const origin = new URL(request.url).origin;

  if (path === "status" && request.method === "GET") {
    return json({ needsSetup: !state.auth, loggedIn: await isAdmin(request, state) });
  }

  if (path === "setup" && request.method === "POST") {
    if (state.auth) return error("Пароль уже задан", 409);
    const body = await readJson(request);
    const password = String(body.password || "");
    if (password.length < 6) return error("Пароль должен быть не короче 6 символов");
    state.auth = await hashPassword(password);
    state.sessionSecret = randomToken(32);
    state.momToken = randomToken(18);
    state.vapid = await generateVapidKeys();
    state.origin = origin;
    await saveState(env, state);
    return json({ ok: true }, 200, { "Set-Cookie": await makeSessionCookie(state) });
  }

  if (path === "login" && request.method === "POST") {
    if (!state.auth) return error("Сначала задайте пароль", 409);
    const body = await readJson(request);
    const { hash } = await hashPassword(String(body.password || ""), state.auth.salt);
    if (!safeEqual(hash, state.auth.hash)) return error("Неверный пароль", 401);
    return json({ ok: true }, 200, { "Set-Cookie": await makeSessionCookie(state) });
  }

  if (path === "logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }

  if (!(await isAdmin(request, state))) return error("Нужно войти", 401);

  // Адрес сайта мог измениться (например, свой домен) — запоминаем актуальный.
  if (state.origin !== origin) {
    state.origin = origin;
    await saveState(env, state);
  }

  if (path === "state" && request.method === "GET") return json(adminView(state));

  if (request.method === "GET") return error("Не найдено", 404);
  const body = request.method === "DELETE" ? {} : await readJson(request);

  if (path === "settings" && request.method === "PUT") {
    const s = state.settings;
    if (body.momName !== undefined) s.momName = cleanString(body.momName, 40);
    if (body.timezone !== undefined) {
      if (!isValidTimeZone(body.timezone)) return error("Неизвестный часовой пояс");
      s.timezone = body.timezone;
    }
    if (body.repeatEnabled !== undefined) s.repeatEnabled = Boolean(body.repeatEnabled);
    if (body.repeatInterval !== undefined) s.repeatInterval = Math.min(120, Math.max(5, Math.round(Number(body.repeatInterval) || 15)));
    if (body.repeatCount !== undefined) s.repeatCount = Math.min(5, Math.max(1, Math.round(Number(body.repeatCount) || 2)));
    if (body.notifyMissed !== undefined) s.notifyMissed = Boolean(body.notifyMissed);
    await saveState(env, state);
    return json(adminView(state));
  }

  if (path === "password" && request.method === "POST") {
    const password = String(body.password || "");
    if (password.length < 6) return error("Пароль должен быть не короче 6 символов");
    state.auth = await hashPassword(password);
    await saveState(env, state);
    return json({ ok: true }, 200, { "Set-Cookie": await makeSessionCookie(state) });
  }

  if (path === "medicines" && request.method === "POST") {
    const existing = body.id ? state.medicines.find((m) => m.id === body.id) : null;
    if (body.id && !existing) return error("Лекарство не найдено", 404);
    if (!existing && state.medicines.length >= MAX_MEDICINES) return error("Слишком много лекарств");
    const med = validateMedicine(body, existing);
    if (existing) Object.assign(existing, med);
    else state.medicines.push(med);
    await saveState(env, state);
    return json(adminView(state));
  }

  let m = /^medicines\/([A-Za-z0-9_-]+)$/.exec(path);
  if (m && request.method === "DELETE") {
    state.medicines = state.medicines.filter((x) => x.id !== m[1]);
    await saveState(env, state);
    return json(adminView(state));
  }

  m = /^medicines\/([A-Za-z0-9_-]+)\/pause$/.exec(path);
  if (m && request.method === "POST") {
    const med = state.medicines.find((x) => x.id === m[1]);
    if (!med) return error("Лекарство не найдено", 404);
    setPaused(state, med, body.paused, "admin");
    await saveState(env, state);
    return json(adminView(state));
  }

  if (path === "subscribe" && request.method === "POST") {
    addSubscription(state, "admin", body.subscription, request);
    await saveState(env, state);
    return json(adminView(state));
  }

  m = /^subscriptions\/([A-Za-z0-9_-]+)$/.exec(path);
  if (m && request.method === "DELETE") {
    state.subscriptions = state.subscriptions.filter((s) => s.id !== m[1]);
    await saveState(env, state);
    return json(adminView(state));
  }

  if (path === "test" && request.method === "POST") {
    const role = body.role === "admin" ? "admin" : "mom";
    const r = await pushToRole(state, role, {
      title: "💊 Проверка напоминаний",
      body: role === "mom" ? "Всё работает! Так будут приходить напоминания о таблетках." : "Уведомления для вас работают.",
      tag: `test-${Date.now()}`,
      url: role === "mom" ? `/m/${state.momToken}` : "/admin",
    });
    if (r.changed) await saveState(env, state);
    return json({ ...r, view: adminView(state) });
  }

  if (path === "reset-mom-link" && request.method === "POST") {
    state.momToken = randomToken(18);
    state.subscriptions = state.subscriptions.filter((s) => s.role !== "mom");
    await saveState(env, state);
    return json(adminView(state));
  }

  return error("Не найдено", 404);
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/" || path === "/admin" || path === "/admin/") {
    if (path === "/") return Response.redirect(`${url.origin}/admin`, 302);
    return serveAsset(env, request, "/admin.html");
  }

  let m = /^\/m\/([A-Za-z0-9_-]+)\/manifest\.webmanifest$/.exec(path);
  if (m) {
    return new Response(
      JSON.stringify({
        name: "Таблетки",
        short_name: "Таблетки",
        start_url: `/m/${m[1]}`,
        scope: "/",
        display: "standalone",
        background_color: "#f2f4f8",
        theme_color: "#2f7cf6",
        lang: "ru",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      }),
      { headers: { "Content-Type": "application/manifest+json; charset=utf-8" } },
    );
  }

  m = /^\/m\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (m) {
    return serveAsset(env, request, "/mom.html", { __MANIFEST__: `/m/${m[1]}/manifest.webmanifest` });
  }

  m = /^\/api\/m\/([A-Za-z0-9_-]+)\/([a-z]+)$/.exec(path);
  if (m) {
    const state = await loadState(env);
    return handleMomApi(request, env, state, m[1], m[2]);
  }

  m = /^\/api\/admin\/(.+)$/.exec(path);
  if (m) {
    const state = await loadState(env);
    return handleAdminApi(request, env, state, m[1]);
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await handleFetch(request, env);
    } catch (e) {
      if (e instanceof HttpError) return error(e.message, e.status);
      console.error(e);
      return error("Ошибка на сервере", 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env, new Date(event.scheduledTime)));
  },
};
