// Выбор времени в 24-часовом формате (часы 00–23 и минуты) — без AM/PM,
// независимо от языка и региона телефона.

const pad = (n) => String(n).padStart(2, "0");

/** HTML двух списков «часы : минуты» для значения "08:30". */
export function timeSelectsHtml(value = "09:00") {
  const [h, m] = String(value).split(":").map(Number);
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;
  const minutes = [...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), minute])].sort((a, b) => a - b);
  const hoursOpts = Array.from({ length: 24 }, (_, i) => `<option value="${pad(i)}"${i === hour ? " selected" : ""}>${pad(i)}</option>`).join("");
  const minOpts = minutes.map((i) => `<option value="${pad(i)}"${i === minute ? " selected" : ""}>${pad(i)}</option>`).join("");
  return `<select class="tp-h" aria-label="Часы">${hoursOpts}</select><span class="tp-sep">:</span><select class="tp-m" aria-label="Минуты">${minOpts}</select>`;
}

/** Все выбранные времена внутри контейнера: ["08:30", "20:00"]. */
export function readTimes(container) {
  return [...container.querySelectorAll(".tp-h")].map((h) => `${h.value}:${h.parentElement.querySelector(".tp-m").value}`);
}

/** Подпись часового пояса для людей. */
export function tzLabel(tz) {
  const names = {
    "Europe/Moscow": "по московскому времени",
    "Europe/Kaliningrad": "по калининградскому времени",
    "Europe/Samara": "по самарскому времени",
    "Asia/Yekaterinburg": "по екатеринбургскому времени",
    "Asia/Novosibirsk": "по новосибирскому времени",
    "Asia/Vladivostok": "по владивостокскому времени",
  };
  return names[tz] || `часовой пояс: ${tz}`;
}
