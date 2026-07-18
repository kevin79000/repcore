// Cloud Functions RepCore
//   - RCACCESS : signature/vérification serveur des codes d'accès élève (HMAC)
//   - PayPal   : vérification côté serveur de l'abonnement avant activation
//
// Déploiement : voir functions/README.md.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.database();

// Région Europe par défaut pour toutes les fonctions de ce fichier (latence + résidence des données).
setGlobalOptions({ region: "europe-west1" });

const TOKEN_SECRET = defineSecret("RCACCESS_TOKEN_SECRET");
const PAYPAL_CLIENT_SECRET = defineSecret("PAYPAL_CLIENT_SECRET");

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// ── Constantes PayPal (valeurs publiques — déjà présentes dans index.html) ───
const PAYPAL_CLIENT_ID = "AS9pdM1fxqdyzKzvuiQB3mTPAIHZW12rW_KWAOKB8XkalJXV8kEyWWBzwHPUxCBZtMMzqjJNnAjfa1f1";
const PAYPAL_PLAN_ID   = "P-95N51603RD882780YNJKS2QA";
const PAYPAL_API       = "https://api.paypal.com";

// ── Helpers PayPal ────────────────────────────────────────────────────────────
async function getPaypalToken(clientSecret) {
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${clientSecret}`).toString("base64");
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new HttpsError("internal", `PayPal OAuth2 échoué (${res.status}).`);
  const j = await res.json();
  if (!j.access_token) throw new HttpsError("internal", "Token PayPal absent de la réponse.");
  return j.access_token;
}

async function fetchSubscription(subscriptionId, accessToken) {
  if (!/^I-[A-Z0-9]{16,}$/.test(subscriptionId)) {
    throw new HttpsError("invalid-argument", "Format d'identifiant d'abonnement invalide.");
  }
  const res = await fetch(`${PAYPAL_API}/v1/billing/subscriptions/${subscriptionId}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (res.status === 404) throw new HttpsError("not-found", "Abonnement PayPal introuvable.");
  if (!res.ok) throw new HttpsError("internal", `Erreur PayPal (${res.status}).`);
  return res.json();
}

function sign(payloadStr, secret) {
  return crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");
}

function emailKey(email) {
  return String(email || "").toLowerCase().replace(/\./g, ",");
}

function buildToken(payload, secret) {
  const payloadStr = JSON.stringify(payload);
  const sig = sign(payloadStr, secret);
  const b64 = Buffer.from(payloadStr, "utf8").toString("base64");
  return "RCACCESS:" + b64 + "." + sig;
}

async function requireCoach(request) {
  if (!request.auth || !request.auth.token || !request.auth.token.email) {
    throw new HttpsError("unauthenticated", "Connecte-toi pour effectuer cette action.");
  }
  const email = request.auth.token.email.toLowerCase();
  const snap = await db.ref("users/" + emailKey(email)).get();
  const coach = snap.val();
  if (!coach || coach.role !== "coach") {
    throw new HttpsError("permission-denied", "Cette action est réservée à un compte coach.");
  }
  return { coach, email };
}

// ── generateAccessToken ──────────────────────────────────────────────────
// Appelée par un coach connecté pour créer un nouveau code d'accès élève.
// coachId/coachName/coachCode viennent TOUJOURS du profil coach authentifié côté serveur,
// jamais de ce que le client prétend — impossible de générer un code au nom d'un autre coach.
exports.generateAccessToken = onCall({ secrets: [TOKEN_SECRET] }, async (request) => {
  const { coach } = await requireCoach(request);

  const studentName = String(request.data && request.data.studentName || "").trim().slice(0, 100);
  if (!studentName) throw new HttpsError("invalid-argument", "Nom de l'élève requis.");
  const months = Math.min(Math.max(parseInt(request.data && request.data.months) || 3, 1), 24);

  const expiry = Date.now() + months * MONTH_MS;
  const codeId = "sc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  const payload = {
    coachId: coach.id,
    coachName: (coach.fname || "") + " " + (coach.lname || ""),
    coachCode: coach.code || null,
    studentName,
    expiry,
    months,
    codeId,
  };
  return { token: buildToken(payload, TOKEN_SECRET.value()), payload };
});

// ── extendAccessToken ────────────────────────────────────────────────────
// Prolonge un code existant (ex. bouton "+3 mois"). Si l'élève est déjà inscrit (athleteEmail
// connu), applique aussi la nouvelle expiration directement sur son compte, immédiatement —
// corrige le bug où "+3 mois" ne changeait jamais rien pour un élève déjà lié.
exports.extendAccessToken = onCall({ secrets: [TOKEN_SECRET] }, async (request) => {
  const { coach, email } = await requireCoach(request);
  const codeId = String(request.data && request.data.codeId || "");
  const codes = Array.isArray(coach.studentCodes) ? coach.studentCodes : [];
  const idx = codes.findIndex((c) => c.codeId === codeId);
  if (idx === -1) throw new HttpsError("not-found", "Code introuvable.");

  const c = codes[idx];
  const addMonths = Math.min(Math.max(parseInt(request.data && request.data.months) || 3, 1), 24);
  const base = Math.max(c.expiry || 0, Date.now());
  const expiry = base + addMonths * MONTH_MS;
  const months = (c.months || 0) + addMonths;

  const payload = {
    coachId: coach.id,
    coachName: (coach.fname || "") + " " + (coach.lname || ""),
    coachCode: coach.code || null,
    studentName: c.studentName,
    expiry,
    months,
    codeId,
  };
  const token = buildToken(payload, TOKEN_SECRET.value());
  codes[idx] = Object.assign({}, c, { expiry, months, token });

  const updates = {};
  updates["users/" + emailKey(email) + "/studentCodes"] = codes;
  let appliedImmediately = false;
  if (c.athleteEmail) {
    const athSnap = await db.ref("users/" + emailKey(c.athleteEmail)).get();
    if (athSnap.exists()) {
      updates["users/" + emailKey(c.athleteEmail) + "/accessExpiry"] = expiry;
      appliedImmediately = true;
    }
  }
  await db.ref().update(updates);
  return { token, payload, appliedImmediately };
});

// ── verifyAccessToken ────────────────────────────────────────────────────
// Appelée côté élève au moment de saisir un code. Recalcule la signature HMAC et la compare en
// temps constant — un token modifié ou fabriqué à la main est rejeté ici, jamais accepté sur la
// seule foi du contenu décodé côté client. Vérifie aussi expiration + code désactivé + usage
// unique (un même codeId ne peut être redeemed que par un seul élève).
exports.verifyAccessToken = onCall({ secrets: [TOKEN_SECRET] }, async (request) => {
  const raw = String(request.data && request.data.token || "");
  if (!raw.startsWith("RCACCESS:")) {
    throw new HttpsError("invalid-argument", "Format de code invalide.");
  }
  const body = raw.slice("RCACCESS:".length);
  const dot = body.lastIndexOf(".");
  if (dot === -1) throw new HttpsError("invalid-argument", "Code invalide ou corrompu.");
  const b64 = body.slice(0, dot);
  const sig = body.slice(dot + 1);

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    throw new HttpsError("invalid-argument", "Code invalide ou corrompu.");
  }

  const expected = sign(JSON.stringify(payload), TOKEN_SECRET.value());
  const given = Buffer.from(sig || "", "hex");
  const wanted = Buffer.from(expected, "hex");
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    throw new HttpsError("permission-denied", "Ce code n'a pas été émis par le serveur (signature invalide).");
  }
  if (!payload.coachId || !payload.expiry) {
    throw new HttpsError("invalid-argument", "Code invalide.");
  }
  if (Date.now() > payload.expiry) {
    throw new HttpsError("failed-precondition", "Ce code a expiré. Demande un nouveau code à ton coach.");
  }

  // Vérifie l'état réel du code chez le coach (actif / déjà consommé par quelqu'un d'autre).
  const coachSnap = await db.ref("users")
    .orderByChild("id")
    .equalTo(payload.coachId)
    .get();
  let coachEmailKey = null;
  let coach = null;
  coachSnap.forEach((child) => { coach = child.val(); coachEmailKey = child.key; });

  const callerEmail = request.auth && request.auth.token && request.auth.token.email
    ? request.auth.token.email.toLowerCase() : null;

  if (coach && Array.isArray(coach.studentCodes)) {
    const idx = coach.studentCodes.findIndex((c) => c.codeId === payload.codeId);
    if (idx !== -1) {
      const sc = coach.studentCodes[idx];
      if (sc.active === false) {
        throw new HttpsError("permission-denied", "Ce code a été désactivé par ton coach.");
      }
      if (sc.redeemed && sc.athleteEmail && callerEmail && sc.athleteEmail !== callerEmail) {
        throw new HttpsError("permission-denied", "Ce code a déjà été utilisé par un autre compte.");
      }
      if (!sc.redeemed && callerEmail) {
        const athleteName = String(request.data && request.data.athleteName || sc.usedBy || "").slice(0, 100);
        coach.studentCodes[idx] = Object.assign({}, sc, {
          redeemed: true,
          athleteEmail: callerEmail,
          usedBy: athleteName || sc.usedBy,
        });
        await db.ref("users/" + coachEmailKey + "/studentCodes").set(coach.studentCodes);
      }
    }
  }

  return { valid: true, payload };
});

// ── verifyPaypalSubscription ─────────────────────────────────────────────────
// Appelée par onApprove() dans index.html après que PayPal a approuvé l'abonnement.
// Le statut AUTONOMIE_PREMIUM n'est écrit dans la base QUE si PayPal confirme
// que l'abonnement est ACTIVE et correspond au bon plan — le client ne peut pas
// se l'attribuer lui-même en falsifiant l'appel JS.
exports.verifyPaypalSubscription = onCall({ secrets: [PAYPAL_CLIENT_SECRET] }, async (request) => {
  // 1. Auth obligatoire — l'email vient du token Firebase, pas du client.
  if (!request.auth || !request.auth.token || !request.auth.token.email) {
    throw new HttpsError("unauthenticated", "Connecte-toi pour activer l'abonnement.");
  }
  const userEmail = request.auth.token.email.toLowerCase();

  // 2. Paramètre subscriptionId transmis par le client.
  const subscriptionId = String(request.data && request.data.subscriptionId || "").trim();
  if (!subscriptionId) throw new HttpsError("invalid-argument", "subscriptionId manquant.");

  // 3. Vérification auprès de l'API PayPal.
  const ppToken = await getPaypalToken(PAYPAL_CLIENT_SECRET.value());
  const sub = await fetchSubscription(subscriptionId, ppToken);

  // 4. Contrôles métier — statut et plan.
  if (sub.status !== "ACTIVE") {
    throw new HttpsError(
      "failed-precondition",
      `Abonnement non actif côté PayPal (statut reçu : ${sub.status}).`
    );
  }
  if (sub.plan_id !== PAYPAL_PLAN_ID) {
    throw new HttpsError(
      "permission-denied",
      "Cet abonnement ne correspond pas au plan RepCore."
    );
  }

  // 5. Écriture dans RTDB via Admin SDK — le client n'écrit plus jamais ce bloc.
  const key = emailKey(userEmail);
  const updates = {
    [`users/${key}/status`]:               "AUTONOMIE_PREMIUM",
    [`users/${key}/paymentStatus`]:        "active",
    [`users/${key}/paypalSubscriptionId`]: subscriptionId,
    [`users/${key}/updatedAt`]:            Date.now(),
  };

  // Optionnel : rattachement à un coach transmis en session (non critique — pas de gain financier).
  const pendingCoachId   = request.data && request.data.coachId   ? String(request.data.coachId).slice(0, 64)   : null;
  const pendingCoachName = request.data && request.data.coachName ? String(request.data.coachName).slice(0, 120) : null;
  if (pendingCoachId) {
    updates[`users/${key}/coachId`]   = pendingCoachId;
    updates[`users/${key}/coachName`] = pendingCoachName || "";
  }

  await db.ref().update(updates);
  return { ok: true };
});
