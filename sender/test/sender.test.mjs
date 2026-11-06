import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import ece from "http_ece";
import { GitHubStore } from "../../web/js/github.js";
import * as core from "../../web/js/core.js";
import { generateVapidKeys, sendPush, b64urlEncode } from "../../web/js/webpush.js";
import { collectEvents, runOnce } from "../send.mjs";

// ---- Поддельный GitHub Contents API (в памяти, с проверкой sha как у настоящего) ----
function fakeGitHub() {
  const files = new Map();
  let n = 0;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    assert.match(init.headers.Authorization, /^Bearer /);
    if (u.pathname === "/repos/me/data") return Response.json({ private: true, permissions: { push: true } });
    if (u.pathname === "/repos/me/data/contents/") {
      return Response.json([...files.keys()].map((name) => ({ name, type: "file" })).concat([{ name: "README.md", type: "file" }]));
    }
    const m = /^\/repos\/me\/data\/contents\/(.+)$/.exec(u.pathname);
    if (!m) return Response.json({ message: "Not Found" }, { status: 404 });
    const f = files.get(m[1]);
    if (init.method === "GET") return f ? Response.json({ content: f.content, sha: f.sha }) : Response.json({ message: "Not Found" }, { status: 404 });
    const body = JSON.parse(init.body);
    if (f && body.sha !== f.sha) return Response.json({ message: "sha mismatch" }, { status: 409 });
    if (!f && body.sha) return Response.json({ message: "sha mismatch" }, { status: 409 });
    const sha = `sha${++n}`;
    files.set(m[1], { content: body.content, sha });
    return Response.json({ content: { sha } });
  };
  return { files, fetchImpl, calls };
}

function phone(endpoint) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) } },
    decrypt: (body) => JSON.parse(ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ecdh, authSecret: auth }).toString()),
  };
}

const msk = (s) => Date.parse(`${s}:00+03:00`);

test("хранилище: кириллица, одновременная запись с двух устройств", async () => {
  const gh = fakeGitHub();
  const store = new GitHubStore({ token: "t", repo: "me/data", fetchImpl: gh.fetchImpl });
  assert.deepEqual(await store.read(), { state: null, sha: null });
  await store.write(core.defaultState(), null, "init");
  const a = new GitHubStore({ token: "t", repo: "me/data", fetchImpl: gh.fetchImpl });

  // Устройство B успевает записать между чтением и записью устройства A — A повторяет попытку.
  let interfered = false;
  await a.update(async (s) => {
    if (!interfered) {
      interfered = true;
      await store.update((s2) => void core.saveMedicine(s2, { name: "Витамин Д", times: ["09:00"] }));
    }
    core.saveMedicine(s, { name: "Аспирин", times: ["08:00"] });
  });
  const { state } = await store.read();
  assert.deepEqual(state.medicines.map((m) => m.name).sort(), ["Аспирин", "Витамин Д"]);
  assert.deepEqual(await store.checkAccess(), { private: true });
});

test("окно рассылки: напоминание приходит, даже если запуск опоздал, и не дублируется", () => {
  const state = core.defaultState();
  state.settings.repeatCount = 2;
  core.saveMedicine(state, { name: "Аспирин", times: ["08:00"] });
  const kinds = (from, to) => collectEvents(state, msk(from), msk(to)).map((e) => `${e.kind}:${e.n}`);

  assert.deepEqual(kinds("2026-11-06T07:55", "2026-11-06T08:00"), ["dose:0"]);
  assert.deepEqual(kinds("2026-11-06T07:58", "2026-11-06T08:07"), ["dose:0"]); // запуск опоздал на 7 минут
  assert.deepEqual(kinds("2026-11-06T08:00", "2026-11-06T08:05"), []); // 08:00 уже обработано
  assert.deepEqual(kinds("2026-11-06T07:50", "2026-11-06T08:20"), ["repeat:1"]); // большая задержка — одно, самое свежее
  assert.deepEqual(kinds("2026-11-06T08:40", "2026-11-06T08:50"), ["missed:0"]);
  assert.deepEqual(kinds("2026-11-05T00:00", "2026-11-06T12:00"), [], "старше 3 часов — не присылаем");
});

test("полный сценарий: страница → данные → рассыльщик → push", async () => {
  const gh = fakeGitHub();
  const store = new GitHubStore({ token: "t", repo: "me/data", fetchImpl: gh.fetchImpl });
  const state = core.defaultState();
  state.vapid = await generateVapidKeys();
  state.settings.momName = "мама";
  await store.write(state, null, "init");

  const mom = phone("https://web.push.apple.com/mom");
  const son = phone("https://web.push.apple.com/son");
  const old = phone("https://web.push.apple.com/gone");
  let medId;
  await store.update((s) => {
    medId = core.saveMedicine(s, { name: "Аспирин", dosage: "1 таблетка", note: "после еды", times: ["08:00"] }).id;
    core.addSubscription(s, "mom", mom.subscription, "iPhone");
    core.addSubscription(s, "mom", old.subscription, "iPhone");
    core.addSubscription(s, "admin", son.subscription, "Android");
  });

  const delivered = [];
  const fakeApple = async (url, init) => {
    delivered.push({ url, init });
    return new Response("", { status: url.endsWith("/gone") ? 410 : 201 });
  };
  const send = (sub, payload, vapid, subject) => sendPush(sub, payload, vapid, subject, fakeApple);

  // 08:00 — маме приходит напоминание; устаревший телефон удаляется.
  let r = await runOnce({ store, fromMs: msk("2026-11-06T07:55"), toMs: msk("2026-11-06T08:03"), subject: "https://me.github.io", send });
  assert.deepEqual(r, { messages: 1, sent: 1, failed: 1, removed: 1 });
  const msg = mom.decrypt(delivered.find((d) => d.url.endsWith("/mom")).init.body);
  assert.equal(msg.title, "💊 Пора принять: Аспирин");
  assert.match(msg.body, /08:00 — 1 таблетка, после еды/);
  assert.equal((await store.read()).state.subscriptions.length, 2);

  // Мама нажала «Выпила» — повторов нет.
  await store.update((s) => core.setTaken(s, medId, "08:00", "2026-11-06", true));
  delivered.length = 0;
  r = await runOnce({ store, fromMs: msk("2026-11-06T08:03"), toMs: msk("2026-11-06T08:50"), subject: "x", send });
  assert.equal(delivered.length, 0);

  // «Закончились таблетки» — сыну приходит сообщение, рассылка на паузе.
  await store.update((s) => core.setPaused(s, medId, true, "mom"));
  r = await runOnce({ store, fromMs: msk("2026-11-07T07:55"), toMs: msk("2026-11-07T08:05"), subject: "x", send });
  assert.equal(delivered.length, 1);
  assert.equal(son.decrypt(delivered[0].init.body).title, "💊 Закончились таблетки: Аспирин");
  assert.equal((await store.read()).state.outbox.length, 0, "очередь очищена");

  // Кнопка «Проверить уведомления» на телефоне мамы — только на этот телефон.
  delivered.length = 0;
  await store.update((s) => core.queueTest(s, { role: "mom", endpoint: mom.subscription.endpoint }));
  await runOnce({ store, fromMs: msk("2026-11-07T08:05"), toMs: msk("2026-11-07T08:10"), subject: "x", send });
  assert.equal(delivered.length, 1);
  assert.equal(mom.decrypt(delivered[0].init.body).title, "✅ Проверка: всё работает!");

  // «Купили» — снова напоминаем.
  await store.update((s) => core.setPaused(s, medId, false, "admin"));
  delivered.length = 0;
  await runOnce({ store, fromMs: msk("2026-11-08T07:55"), toMs: msk("2026-11-08T08:00"), subject: "x", send });
  assert.equal(delivered.length, 1);
});

test("проверка данных", () => {
  const s = core.defaultState();
  assert.throws(() => core.saveMedicine(s, { name: " ", times: ["08:00"] }), /название/);
  assert.throws(() => core.saveMedicine(s, { name: "А", times: ["25:00"] }), /время/);
  const med = core.saveMedicine(s, { name: "А", times: ["20:00", "08:00", "08:00"], days: [1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(med.times, ["08:00", "20:00"]);
  assert.deepEqual(med.days, []);
  assert.throws(() => core.addSubscription(s, "mom", { endpoint: "http://x", keys: {} }), /подписка/);
});

test("несколько человек: у каждого своё расписание, ссылки ведут на свою страницу", async () => {
  const gh = fakeGitHub();
  const base = new GitHubStore({ token: "t", repo: "me/data", fetchImpl: gh.fetchImpl });
  const mom = core.defaultState();
  mom.vapid = await generateVapidKeys();
  core.saveMedicine(mom, { name: "Аспирин", times: ["08:00"] });
  await base.write(mom, null, "init");

  const me = core.newProfileState("Тимур", mom.vapid, "m");
  core.saveMedicine(me, { name: "Витамин Д", times: ["09:00"] });
  const phone1 = phone("https://fcm.googleapis.com/fcm/send/samsung");
  core.addSubscription(me, "mom", phone1.subscription, "Android");
  await base.update((s) => void core.addSubscription(s, "admin", phone1.subscription, "Android")); // тот же телефон получает и сообщения о маме
  assert.deepEqual(await base.listProfileFiles(), ["state.json"]);

  // Записываем второго человека в отдельный файл.
  const meStore = base.withPath("state-timur.json");
  await meStore.write(me, null, "me");
  assert.deepEqual(await base.listProfileFiles(), ["state.json", "state-timur.json"]);

  const delivered = [];
  const send = (sub, payload, vapid, subject) =>
    sendPush(sub, payload, vapid, subject, async (url, init) => (delivered.push({ url, init }), new Response("", { status: 201 })));

  await runOnce({ store: meStore, fromMs: msk("2026-11-06T08:55"), toMs: msk("2026-11-06T09:00"), subject: "x", send });
  assert.equal(delivered.length, 1);
  const msg = phone1.decrypt(delivered[0].init.body);
  assert.equal(msg.title, "💊 Пора принять: Витамин Д");
  assert.match(msg.body, /«Выпил»/);
  assert.equal(msg.url, "./mom.html?p=state-timur.json");

  // Мамин файл не трогаем: в 09:00 у неё ничего нет.
  delivered.length = 0;
  await runOnce({ store: base.withPath("state.json"), fromMs: msk("2026-11-06T08:55"), toMs: msk("2026-11-06T09:00"), subject: "x", send });
  assert.equal(delivered.length, 0);
  assert.throws(() => base.withPath("../evil.json"), /профиля/);
});
