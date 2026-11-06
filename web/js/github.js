// Хранение данных в файле state.json приватного репозитория GitHub (через GitHub API).
// Работает и в браузере, и в Node (рассыльщик в GitHub Actions).

import { normalizeState, pruneState, PROFILE_FILE_RE } from "./core.js";

const API = "https://api.github.com";
const isBrowser = typeof window !== "undefined";

export class StoreError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubStore {
  constructor({ token, repo, path = "state.json", fetchImpl }) {
    if (!token) throw new StoreError("Нет ключа доступа", 401);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new StoreError("Неверное имя репозитория (нужно владелец/название)", 400);
    this.token = token;
    this.repo = repo;
    this.path = path;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  async request(method, url, body) {
    let res;
    try {
      res = await this.fetch(`${API}${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        ...(isBrowser ? { cache: "no-store" } : {}),
      });
    } catch {
      throw new StoreError("Нет связи с GitHub. Проверьте интернет.", 0);
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let msg = "";
    try {
      msg = (await res.json()).message || "";
    } catch {}
    if (res.status === 401) throw new StoreError("Ключ доступа неверный или просрочен.", 401);
    if (res.status === 404) throw new StoreError("Не найдено (проверьте имя репозитория и права ключа).", 404);
    if (res.status === 403) throw new StoreError(`Нет доступа: ${msg || "у ключа не хватает прав"}`, 403);
    if (res.status === 409 || res.status === 422) throw new StoreError("conflict", 409);
    throw new StoreError(`Ошибка GitHub ${res.status}: ${msg}`, res.status);
  }

  /** Хранилище того же репозитория, но другого файла (профиля). */
  withPath(path) {
    if (!PROFILE_FILE_RE.test(path)) throw new StoreError("Неверное имя профиля", 400);
    return new GitHubStore({ token: this.token, repo: this.repo, path, fetchImpl: this.fetch });
  }

  /** Файлы профилей в репозитории: ["state.json", "state-abc.json", …] — первый всегда основной. */
  async listProfileFiles() {
    let list;
    try {
      list = await this.request("GET", `/repos/${this.repo}/contents/?t=${Date.now()}`);
    } catch (e) {
      if (e.status === 404) return []; // пустой репозиторий
      throw e;
    }
    return list
      .filter((f) => f.type === "file" && PROFILE_FILE_RE.test(f.name))
      .map((f) => f.name)
      .sort((a, b) => (a === "state.json" ? -1 : b === "state.json" ? 1 : a.localeCompare(b)));
  }

  /** Проверяет, что ключ даёт доступ к репозиторию на запись. */
  async checkAccess() {
    let repo;
    try {
      repo = await this.request("GET", `/repos/${this.repo}`);
    } catch (e) {
      if (e.status === 404) {
        throw new StoreError(
          `Ключ не видит репозиторий ${this.repo}. В настройках ключа выберите Repository access → Only select repositories → ${this.repo.split("/")[1]} и Permissions → Contents: Read and write.`,
          404,
        );
      }
      throw e;
    }
    if (repo.permissions && !repo.permissions.push) throw new StoreError("Ключ даёт только чтение. Нужен доступ Contents: Read and write.", 403);
    return { private: repo.private };
  }

  /** Читает состояние. Если файла ещё нет — { state: null, sha: null }. */
  async read() {
    try {
      const file = await this.request("GET", `/repos/${this.repo}/contents/${this.path}?t=${Date.now()}`);
      return { state: normalizeState(JSON.parse(fromB64(file.content))), sha: file.sha };
    } catch (e) {
      if (e.status === 404) {
        // Отличаем «нет файла» от «нет репозитория/доступа».
        try {
          await this.request("GET", `/repos/${this.repo}`);
        } catch (e2) {
          if (e2.status === 404) {
            throw new StoreError(
              `Ключ не видит репозиторий ${this.repo}. В настройках ключа выберите Repository access → Only select repositories → ${this.repo.split("/")[1]} и Permissions → Contents: Read and write.`,
              404,
            );
          }
          throw e2;
        }
        return { state: null, sha: null };
      }
      throw e;
    }
  }

  async write(state, sha, message) {
    const res = await this.request("PUT", `/repos/${this.repo}/contents/${this.path}`, {
      message,
      content: toB64(JSON.stringify(state, null, 1)),
      ...(sha ? { sha } : {}),
    });
    return res.content.sha;
  }

  /**
   * Прочитать → изменить → сохранить. При одновременной записи с другого устройства
   * повторяет попытку на свежих данных.
   */
  async update(mutator, message = "Обновление") {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { state, sha } = await this.read();
      if (!state) throw new StoreError("Данные ещё не созданы. Откройте страницу настроек.", 404);
      const result = await mutator(state);
      pruneState(state);
      try {
        const newSha = await this.write(state, sha, message);
        return { state, sha: newSha, result };
      } catch (e) {
        if (e.status !== 409) throw e;
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
      }
    }
    throw new StoreError("Не удалось сохранить: данные одновременно меняются с другого устройства. Попробуйте ещё раз.", 409);
  }
}
