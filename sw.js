const CACHE = 'repcore-v190';
const SW_DATA = 'repcore-sw-data'; // persistent across updates — not wiped by activate
const ASSETS = ['./manifest.json', './icons/icon-192x192.png', './icons/icon-512x512.png', './icons/logo.png', './data/ciqual.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE && k !== SW_DATA).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Ne jamais intercepter les requêtes cross-origin (Firebase, Cloud Functions, Realtime DB…)
  // Sinon le SW renverrait index.html (HTML) en fallback offline, ce qui fait planter
  // tout appel fetch() qui attend du JSON — notamment generateAccessToken.
  if (!url.startsWith(self.location.origin)) return;
  // index.html : network-first (toujours à jour), fallback cache si offline
  if (url.includes('index.html') || url.endsWith('/') || url.endsWith('/repcore/')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put('./index.html', clone));
        return r;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  // Assets same-origin : cache-first, sans fallback HTML (évite de servir HTML à la place d'un asset)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ─── SW data store (Cache API key/value, survives SW updates) ───────────────
async function swGet(key) {
  try {
    const c = await caches.open(SW_DATA);
    const r = await c.match(key);
    return r ? r.json() : null;
  } catch(e) { return null; }
}
async function swSet(key, val) {
  try {
    const c = await caches.open(SW_DATA);
    await c.put(key, new Response(JSON.stringify(val), { headers: { 'Content-Type': 'application/json' } }));
  } catch(e) {}
}

// ─── Periodic background sync — fires even when app is closed (Chrome/Android) ─
self.addEventListener('periodicsync', e => {
  if (e.tag === 'bilan-reminder') e.waitUntil(swCheckAndNotify());
  if (e.tag === 'wo-reminder') e.waitUntil(swCheckWoReminder());
});

async function swCheckAndNotify() {
  const sched = await swGet('/bilan-schedule');
  if (!sched?.nextDate) return;
  if (Date.now() < sched.nextDate) return;
  const today = new Date().toISOString().slice(0, 10);
  if (await swGet('/bilan-last-notif') === today) return;
  await swSet('/bilan-last-notif', today);
  // Advance schedule by 14 days for the next cycle
  await swSet('/bilan-schedule', { ...sched, nextDate: sched.nextDate + 14 * 24 * 3600 * 1000 });
  const pref = sched.fname ? sched.fname + ', c' : 'C';
  await self.registration.showNotification('RepCore — Bilan bimensuel 📊', {
    body: pref + '\'est le moment de remplir ton bilan coaching ! Suis ton évolution 📈',
    icon: './icons/icon-192x192.png',
    badge: './icons/icon-192x192.png',
    tag: 'bilan-reminder',
    requireInteraction: true,
    data: { url: './?bilan=1' }
  });
}

// ─── Notification click → open / focus app at bilan screen ─────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
      const w = ws.find(c => c.url.startsWith(self.registration.scope));
      return w ? w.focus() : clients.openWindow(url);
    })
  );
});

// ─── Workout reminder ───────────────────────────────────────────────────────
async function swCheckWoReminder() {
  const sched = await swGet('/wo-reminder');
  if (!sched?.enabled) return;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  if (sched.lastNotifDate === todayStr) return;

  const todayJS = now.getDay();                          // 0=Sun … 6=Sat
  const todayApp = todayJS === 0 ? 6 : todayJS - 1;     // 0=Lun … 6=Dim
  if (!(sched.days || []).includes(todayApp)) return;

  const h = now.getHours();
  if (h < (sched.hour ?? 18)) return;       // trop tôt
  if (h >= (sched.hour ?? 18) + 3) return;  // plus de 3h après l'heure cible

  await swSet('/wo-reminder', { ...sched, lastNotifDate: todayStr });

  const pref = sched.fname ? sched.fname + ', c' : 'C';
  await self.registration.showNotification('RepCore — Séance du jour 💪', {
    body: pref + "'est l'heure de t'entraîner ! Lance ta séance maintenant.",
    icon: './icons/icon-192x192.png',
    badge: './icons/icon-192x192.png',
    tag: 'wo-reminder',
    requireInteraction: true,
    data: { url: './?wo=1' }
  });
}

// ─── Server push (future backend / VAPID integration) ──────────────────────
self.addEventListener('push', e => {
  const d = e.data?.json() || {};
  e.waitUntil(self.registration.showNotification(d.title || 'RepCore 💪', {
    body: d.body || 'Rappel RepCore.',
    icon: './icons/icon-192x192.png',
    badge: './icons/icon-192x192.png',
    tag: d.tag || 'repcore',
    data: { url: d.url || './' }
  }));
});
