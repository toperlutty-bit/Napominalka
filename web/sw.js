// Service worker: показывает push-уведомления и открывает страницу по нажатию.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Напоминание", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "💊 Напоминание о таблетках";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      requireInteraction: true,
      icon: new URL("./icon-192.png", self.registration.scope).href,
      badge: new URL("./icon-192.png", self.registration.scope).href,
      data: { url: data.url || "./mom.html" },
      lang: "ru",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "./mom.html", self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of list) {
        if (client.url.split("?")[0] === url.split("?")[0] && "focus" in client) {
          client.postMessage({ type: "refresh" });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
