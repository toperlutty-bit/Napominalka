import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import ece from "http_ece";
import worker, { runSchedule } from "../src/worker.js";
import { b64urlEncode } from "../src/webpush.js";

const ORIGIN = "https://napominalka.example.workers.dev";

function makeEnv() {
  const store = new Map();
  return {
    DB: {
      async get(key, type) {
        const v = store.get(key);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      async put(key, value) {
        store.set(key, value);
      },
    },
    ASSETS: {
      async fetch(req) {
        const path = new URL(req.url).pathname;
        return new Response(`<html>asset ${path} <link rel="manifest" href="__MANIFEST__"></html>`, { headers: { "Content-Type": "text/html" } });
      },
    },
    store,
  };
}

function browser(endpoint) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: { endpoint, keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) } },
    decrypt(body) {
      return JSON.parse(ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ecdh, authSecret: auth }).toString());
    },
  };
}

// Перехватываем отправку push.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), init });
  if (String(url).includes("gone")) return new Response("", { status: 410 });
  return new Response("", { status: 201 });
};

let cookie = "";
async function call(env, method, path, body) {
  const headers = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
  const setCookie = res.headers.get("Set-Cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const type = res.headers.get("Content-Type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
}

test("полный сценарий: настройка, расписание, «Выпила», «Закончились таблетки»", async (t) => {
  const env = makeEnv();
  t.after(() => (globalThis.fetch = realFetch));

  // Без пароля в админку не пускает.
  assert.deepEqual((await call(env, "GET", "/api/admin/status")).body, { needsSetup: true, loggedIn: false });
  assert.equal((await call(env, "GET", "/api/admin/state")).status, 401);

  // Первый запуск: задаём пароль.
  assert.equal((await call(env, "POST", "/api/admin/setup", { password: "123" })).status, 400);
  assert.equal((await call(env, "POST", "/api/admin/setup", { password: "secret123" })).status, 200);
  assert.equal((await call(env, "POST", "/api/admin/setup", { password: "other123" })).status, 409);
  let state = (await call(env, "GET", "/api/admin/state")).body;
  assert.ok(state.momUrl.startsWith(`${ORIGIN}/m/`));
  assert.ok(state.vapidPublicKey);
  const token = state.momUrl.split("/m/")[1];

  // Выход и вход.
  await call(env, "POST", "/api/admin/logout", {});
  cookie = "";
  assert.equal((await call(env, "POST", "/api/admin/login", { password: "wrong" })).status, 401);
  assert.equal((await call(env, "POST", "/api/admin/login", { password: "secret123" })).status, 200);

  // Настройки и лекарство.
  await call(env, "PUT", "/api/admin/settings", { momName: "мама", timezone: "Europe/Moscow", repeatInterval: 15, repeatCount: 1 });
  assert.equal((await call(env, "POST", "/api/admin/medicines", { name: "", times: ["08:00"] })).status, 400);
  state = (await call(env, "POST", "/api/admin/medicines", { name: "Аспирин", dosage: "1 таблетка", note: "после еды", times: ["20:00", "08:00", "08:00", "bad"] })).body;
  const med = state.medicines[0];
  assert.deepEqual(med.times, ["08:00", "20:00"]);

  // Страница мамы: неверная ссылка не работает.
  assert.equal((await call(env, "GET", "/api/m/wrongtoken/today")).status, 404);
  const page = await call(env, "GET", `/m/${token}`);
  assert.match(page.body, new RegExp(`/m/${token}/manifest.webmanifest`));
  const manifest = await call(env, "GET", `/m/${token}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);

  // Мама подписывается на уведомления; родственник — тоже.
  const momPhone = browser("https://web.push.apple.com/mom-device");
  const sonPhone = browser("https://fcm.googleapis.com/fcm/send/son-device");
  assert.equal((await call(env, "POST", `/api/m/${token}/subscribe`, { subscription: momPhone.subscription })).status, 200);
  await call(env, "POST", `/api/m/${token}/subscribe`, { subscription: momPhone.subscription }); // повтор не дублирует
  await call(env, "POST", "/api/admin/subscribe", { subscription: sonPhone.subscription });
  state = (await call(env, "GET", "/api/admin/state")).body;
  assert.equal(state.subscriptions.filter((s) => s.role === "mom").length, 1);
  assert.equal(state.subscriptions[0].label, "iPhone");

  // 08:00 по Москве — маме приходит напоминание.
  const day = "2026-11-06";
  sent.length = 0;
  await runSchedule(env, new Date(`${day}T08:00:00+03:00`));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, momPhone.subscription.endpoint);
  assert.match(sent[0].init.headers.Authorization, /^vapid t=.+, k=.+$/);
  const msg = momPhone.decrypt(sent[0].init.body);
  assert.equal(msg.title, "💊 Пора принять: Аспирин");
  assert.match(msg.body, /08:00 — 1 таблетка, после еды/);
  assert.equal(msg.url, `/m/${token}`);

  // 08:15 — повтор, 08:30 — родственнику «не отмечено».
  sent.length = 0;
  await runSchedule(env, new Date(`${day}T08:15:00+03:00`));
  assert.equal(momPhone.decrypt(sent[0].init.body).title, "⏰ Напоминаю: Аспирин");
  sent.length = 0;
  await runSchedule(env, new Date(`${day}T08:30:00+03:00`));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, sonPhone.subscription.endpoint);
  assert.match(sonPhone.decrypt(sent[0].init.body).title, /мама: приём не отмечен/);

  // Мама нажимает «Выпила» (для сегодняшнего дня по Москве) — вечерний приём ещё впереди.
  const today = (await call(env, "GET", `/api/m/${token}/today`)).body;
  const r = await call(env, "POST", `/api/m/${token}/taken`, { medId: med.id, time: "20:00", day: today.day });
  assert.ok(r.body.doses.find((d) => d.time === "20:00").takenAt);
  sent.length = 0;
  await runSchedule(env, new Date(`${today.day}T20:00:00+03:00`));
  assert.equal(sent.length, 0, "отмеченный приём не напоминаем");

  // «Закончились таблетки»: родственник получает сообщение, рассылка останавливается.
  sent.length = 0;
  const paused = await call(env, "POST", `/api/m/${token}/pause`, { medId: med.id, paused: true });
  assert.ok(paused.body.doses.every((d) => d.paused));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, sonPhone.subscription.endpoint);
  assert.equal(sonPhone.decrypt(sent[0].init.body).title, "💊 Закончились таблетки: Аспирин");
  sent.length = 0;
  await runSchedule(env, new Date(`2026-11-07T08:00:00+03:00`));
  assert.equal(sent.length, 0, "на паузе ничего не присылаем");

  // «Купили» — напоминания снова идут.
  await call(env, "POST", `/api/admin/medicines/${med.id}/pause`, { paused: false });
  await runSchedule(env, new Date(`2026-11-07T08:00:00+03:00`));
  assert.equal(sent.length, 1);

  // Удалённая подписка (410) убирается автоматически.
  const oldPhone = browser("https://web.push.apple.com/gone-device");
  await call(env, "POST", `/api/m/${token}/subscribe`, { subscription: oldPhone.subscription });
  const testRes = await call(env, "POST", "/api/admin/test", { role: "mom" });
  assert.equal(testRes.body.sent, 1);
  assert.equal(testRes.body.failed, 1);
  assert.equal(testRes.body.view.subscriptions.filter((s) => s.role === "mom").length, 1);

  // Новая ссылка для мамы — старая перестаёт работать.
  await call(env, "POST", "/api/admin/reset-mom-link", {});
  assert.equal((await call(env, "GET", `/api/m/${token}/today`)).status, 404);

  // Запросы не-JSON отклоняются (защита от подделки форм).
  const res = await worker.fetch(new Request(`${ORIGIN}/api/admin/settings`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "text/plain" }, body: "{}" }), env);
  assert.equal(res.status, 415);
});

test("в истории нет дней до добавления лекарства", async () => {
  const env = makeEnv();
  cookie = "";
  await call(env, "POST", "/api/admin/setup", { password: "secret123" });
  const view = (await call(env, "POST", "/api/admin/medicines", { name: "Новое", times: ["00:00"] })).body;
  assert.equal(view.history[0].doses.length, 1, "сегодня приём есть");
  assert.ok(view.history.slice(1).every((h) => h.doses.length === 0), "раньше — пусто");
});
