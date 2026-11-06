// Логика расписания: что и кому отправить в данную минуту. Чистые функции — легко тестировать.

export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Местное время в часовом поясе tz: { day: "2026-11-06", minutes: 485, weekday: 1..7 (Пн=1) }. */
export function localTime(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wdMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const hour = Number(get("hour")) % 24;
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
    weekday: wdMap[get("weekday")],
  };
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "08:30" -> 510 */
export function parseTime(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 510 -> "08:30" */
export function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Предыдущий день "YYYY-MM-DD". */
export function previousDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function doseKey(medId, time) {
  return `${medId}|${time}`;
}

export function isTaken(state, day, medId, time) {
  return Boolean(state.taken?.[day]?.[doseKey(medId, time)]);
}

function takesOnWeekday(med, weekday) {
  return !Array.isArray(med.days) || med.days.length === 0 || med.days.includes(weekday);
}

/**
 * Какие уведомления нужно отправить в эту минуту.
 * Возвращает массив { kind: "dose" | "repeat" | "missed", med, time, day, n }.
 *  - dose   — основное напоминание маме;
 *  - repeat — повтор маме, если приём не отмечен;
 *  - missed — сообщение родственникам, что приём так и не отмечен.
 */
export function dueEvents(state, date) {
  const s = state.settings || {};
  const tz = s.timezone || "Europe/Moscow";
  const interval = Math.max(1, Number(s.repeatInterval) || 15);
  const count = Math.max(0, Math.min(10, Number(s.repeatCount ?? 2)));
  const missedAfter = (count + 1) * interval;

  const now = localTime(date, tz);
  const candidates = [
    { day: now.day, weekday: now.weekday, offset: 0 },
    // Повторы после полуночи для вчерашних поздних приёмов.
    { day: previousDay(now.day), weekday: now.weekday === 1 ? 7 : now.weekday - 1, offset: 1440 },
  ];

  const events = [];
  for (const med of state.medicines || []) {
    if (med.paused) continue;
    for (const time of med.times || []) {
      const t = parseTime(time);
      if (t === null) continue;
      for (const c of candidates) {
        const diff = now.minutes + c.offset - t;
        if (diff < 0 || (c.offset > 0 && diff >= 1440)) continue;
        if (c.offset > 0 && diff > missedAfter) continue;
        if (!takesOnWeekday(med, c.weekday)) continue;
        if (isTaken(state, c.day, med.id, time)) continue;

        if (diff === 0) {
          events.push({ kind: "dose", med, time, day: c.day, n: 0 });
        } else if (s.repeatEnabled !== false && count > 0 && diff % interval === 0 && diff / interval <= count) {
          events.push({ kind: "repeat", med, time, day: c.day, n: diff / interval });
        } else if (s.notifyMissed !== false && diff === missedAfter) {
          events.push({ kind: "missed", med, time, day: c.day, n: 0 });
        }
      }
    }
  }
  return events;
}

/** Приёмы на день (для страниц). */
export function dosesForDay(state, day, weekday) {
  const list = [];
  for (const med of state.medicines || []) {
    if (!takesOnWeekday(med, weekday)) continue;
    for (const time of med.times || []) {
      if (parseTime(time) === null) continue;
      const takenAt = state.taken?.[day]?.[doseKey(med.id, time)] || null;
      list.push({
        medId: med.id,
        name: med.name,
        dosage: med.dosage || "",
        note: med.note || "",
        color: med.color || "#2f7cf6",
        time,
        day,
        takenAt,
        paused: Boolean(med.paused),
      });
    }
  }
  return list.sort((a, b) => parseTime(a.time) - parseTime(b.time) || a.name.localeCompare(b.name, "ru"));
}
