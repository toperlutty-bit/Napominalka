// Будильник напоминаний на Cloudflare Workers: каждую минуту читает расписание из приватного
// репозитория GitHub и отправляет push-уведомления. Телефонам обращаться к нему не нужно —
// поэтому блокировки *.workers.dev в России не мешают.
//
// Настройки: секрет DATA_TOKEN (ключ к репозиторию с данными), переменная DATA_REPO.

import { GitHubStore } from "../web/js/github.js";
import { runAll } from "../sender/runner.js";

const MINUTE = 60_000;

function makeBase(env) {
  return new GitHubStore({ token: env.DATA_TOKEN, repo: env.DATA_REPO, fetchImpl: (...a) => fetch(...a) });
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.DATA_TOKEN) {
      console.log("Не задан секрет DATA_TOKEN — рассылка не настроена.");
      return;
    }
    // Окно ровно в одну минуту: (t − 1 мин, t]. Cloudflare запускает cron каждую минуту.
    const toMs = Math.floor(event.scheduledTime / MINUTE) * MINUTE;
    ctx.waitUntil(
      runAll({ base: makeBase(env), fromMs: toMs - MINUTE, toMs, subject: env.SUBJECT }).then((r) => {
        if (r.failed) console.log(`Ошибки: ${r.failed} из ${r.profiles}`);
      }),
    );
  },

  // Проверка состояния без отправки: видит ли будильник данные.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/status") return new Response("Напоминалка: будильник работает. Состояние — /status\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const out = { tokenSet: Boolean(env.DATA_TOKEN), repo: env.DATA_REPO, now: new Date().toISOString() };
    if (env.DATA_TOKEN) {
      try {
        const base = makeBase(env);
        const files = await base.listProfileFiles();
        out.profiles = files.length;
        out.dataOk = true;
        const { state } = await base.withPath(files[0] || "state.json").read();
        out.firstProfileReady = Boolean(state?.vapid);
      } catch (e) {
        out.dataOk = false;
        out.error = e.message;
      }
    }
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  },
};
