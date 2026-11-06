import { test } from "node:test";
import assert from "node:assert/strict";
import { dueEvents, localTime, previousDay, dosesForDay } from "../../web/js/schedule.js";

// 2026-11-06 — пятница. Москва = UTC+3.
const at = (hhmm, day = "2026-11-06") => new Date(`${day}T${hhmm}:00+03:00`);

const base = () => ({
  settings: { timezone: "Europe/Moscow", repeatEnabled: true, repeatInterval: 15, repeatCount: 2, notifyMissed: true },
  medicines: [{ id: "a", name: "Аспирин", times: ["08:00", "23:50"], paused: false }],
  taken: {},
});

const kinds = (events) => events.map((e) => `${e.kind}:${e.time}:${e.day}:${e.n}`);

test("локальное время считается в часовом поясе", () => {
  assert.deepEqual(localTime(at("08:05"), "Europe/Moscow"), { day: "2026-11-06", minutes: 485, weekday: 5 });
  assert.deepEqual(localTime(new Date("2026-11-06T00:30:00Z"), "Asia/Vladivostok"), { day: "2026-11-06", minutes: 630, weekday: 5 });
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
});

test("основное напоминание, повторы и сообщение о пропуске", () => {
  const s = base();
  assert.deepEqual(kinds(dueEvents(s, at("08:00"))), ["dose:08:00:2026-11-06:0"]);
  assert.deepEqual(kinds(dueEvents(s, at("08:01"))), []);
  assert.deepEqual(kinds(dueEvents(s, at("08:15"))), ["repeat:08:00:2026-11-06:1"]);
  assert.deepEqual(kinds(dueEvents(s, at("08:30"))), ["repeat:08:00:2026-11-06:2"]);
  assert.deepEqual(kinds(dueEvents(s, at("08:45"))), ["missed:08:00:2026-11-06:0"]);
  assert.deepEqual(kinds(dueEvents(s, at("09:00"))), []);
});

test("если приём отмечен — ничего не присылаем", () => {
  const s = base();
  s.taken = { "2026-11-06": { "a|08:00": "2026-11-06T05:01:00Z" } };
  assert.deepEqual(kinds(dueEvents(s, at("08:15"))), []);
  assert.deepEqual(kinds(dueEvents(s, at("08:45"))), []);
});

test("«Закончились таблетки» — рассылка на паузе", () => {
  const s = base();
  s.medicines[0].paused = true;
  assert.deepEqual(dueEvents(s, at("08:00")), []);
});

test("повторы после полуночи относятся ко вчерашнему дню", () => {
  const s = base();
  assert.deepEqual(kinds(dueEvents(s, at("23:50"))), ["dose:23:50:2026-11-06:0"]);
  assert.deepEqual(kinds(dueEvents(s, at("00:05", "2026-11-07"))), ["repeat:23:50:2026-11-06:1"]);
  assert.deepEqual(kinds(dueEvents(s, at("00:35", "2026-11-07"))), ["missed:23:50:2026-11-06:0"]);
});

test("дни недели и выключенные повторы", () => {
  const s = base();
  s.medicines[0].days = [1, 3]; // Пн, Ср — а сегодня пятница
  assert.deepEqual(dueEvents(s, at("08:00")), []);
  s.medicines[0].days = [5];
  s.settings.repeatEnabled = false;
  s.settings.notifyMissed = false;
  assert.deepEqual(kinds(dueEvents(s, at("08:00"))), ["dose:08:00:2026-11-06:0"]);
  assert.deepEqual(dueEvents(s, at("08:15")), []);
  assert.deepEqual(dueEvents(s, at("08:45")), []);
});

test("список приёмов на день отсортирован по времени", () => {
  const s = base();
  s.medicines.push({ id: "b", name: "Витамин", times: ["07:30"] });
  const list = dosesForDay(s, "2026-11-06", 5);
  assert.deepEqual(list.map((d) => d.time), ["07:30", "08:00", "23:50"]);
});
