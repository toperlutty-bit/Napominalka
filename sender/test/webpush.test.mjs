import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import ece from "http_ece";
import { encryptPayload, generateVapidKeys, vapidAuthHeader, sendPush, b64urlDecode, b64urlEncode } from "../../web/js/webpush.js";

// Имитируем браузер: ключи подписки.
function makeBrowserSubscription() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: "https://web.push.apple.com/QGuQyavXutnMH",
      keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) },
    },
  };
}

test("зашифрованное сообщение расшифровывается независимой реализацией (http_ece)", async () => {
  const { ecdh, auth, subscription } = makeBrowserSubscription();
  const text = JSON.stringify({ title: "💊 Пора принять лекарство", body: "Аспирин — 1 таблетка" });
  const body = await encryptPayload(subscription, text);
  const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ecdh, authSecret: auth });
  assert.equal(plain.toString("utf8"), text);
});

test("VAPID JWT подписан правильно и содержит нужные поля", async () => {
  const vapid = await generateVapidKeys();
  const header = await vapidAuthHeader("https://web.push.apple.com/abc", vapid, "https://example.workers.dev");
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, header);
  const [h, p, s] = m[1].split(".");
  const payload = JSON.parse(Buffer.from(b64urlDecode(p)).toString());
  assert.equal(payload.aud, "https://web.push.apple.com");
  assert.equal(payload.sub, "https://example.workers.dev");
  assert.ok(payload.exp > Date.now() / 1000);
  assert.equal(m[2], vapid.publicKey);
  assert.equal(b64urlDecode(vapid.publicKey).length, 65);

  const pub = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: vapid.privateJwk.x, y: vapid.privateJwk.y },
    format: "jwk",
  });
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(b64urlDecode(s)));
  assert.ok(ok, "подпись должна проверяться");
});

test("sendPush отправляет правильные заголовки и помечает удалённые подписки", async () => {
  const { ecdh, auth, subscription } = makeBrowserSubscription();
  const vapid = await generateVapidKeys();
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response("", { status: 201 });
  };
  const r = await sendPush(subscription, { title: "Тест" }, vapid, "https://x.dev", fakeFetch);
  assert.equal(r.ok, true);
  assert.equal(captured.url, subscription.endpoint);
  assert.equal(captured.init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(captured.init.headers.TTL, "86400");
  const plain = ece.decrypt(Buffer.from(captured.init.body), { version: "aes128gcm", privateKey: ecdh, authSecret: auth });
  assert.deepEqual(JSON.parse(plain.toString()), { title: "Тест" });

  const gone = await sendPush(subscription, { title: "x" }, vapid, "https://x.dev", async () => new Response("", { status: 410 }));
  assert.equal(gone.gone, true);
});
