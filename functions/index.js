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
const CLOUDINARY_API_SECRET = defineSecret("CLOUDINARY_API_SECRET");
const CLOUDINARY_API_KEY = defineSecret("CLOUDINARY_API_KEY");
const OCR_SPACE_API_KEY = defineSecret("OCR_SPACE_API_KEY");

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const CREATOR_EMAIL = "guellec.coachingpro@gmail.com";

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
  const freeCode = !!(request.data && request.data.freeCode) &&
    request.auth.token.email.toLowerCase() === CREATOR_EMAIL;

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
  if (freeCode) payload.creatorFree = true;
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

// ── anonymizeCoach ───────────────────────────────────────────────────────────
// Appelée en self-service par un coach voulant supprimer son compte, ou par le
// créateur (CREATOR_EMAIL) pour offboarder un coach tiers via targetEmail.
//
// ── Choix RGPD — suppression dure avec archivage financier minimal ──────────
// Art. 17 RGPD (droit à l'effacement) :
//   • Données personnelles (fname, lname, phone, photo, programmes, codes…) :
//     SUPPRIMÉES — la clé users/{emailKey} est effacée intégralement.
//   • Compte Firebase Auth : SUPPRIMÉ via Admin SDK.
//   • Données financières (paypalSubscriptionId, paymentStatus, status) :
//     ARCHIVÉES 5 ans sans PII sous /deleted_accounts/{anonId}, obligation
//     légale de conservation des preuves contractuelles (art. L. 110-4 C. com.).
//   • Alternative "stub" rejetée : conserver l'email en clair sous users/
//     aurait maintenu une PII en base, contraire à l'esprit de l'Art. 17.
//   • Les coachId orphelins chez les athlètes sont tolérés : le code client
//     gère déjà find()===undefined sans planter ; offboardCoach() garantit
//     l'absence d'athlètes restants avant d'appeler cette fonction.
exports.anonymizeCoach = onCall(async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.email) {
    throw new HttpsError("unauthenticated", "Connexion requise.");
  }
  const callerEmail = request.auth.token.email.toLowerCase();
  const CREATOR = "guellec.coachingpro@gmail.com";
  const isCreator = callerEmail === CREATOR;

  const rawTarget = request.data && request.data.targetEmail
    ? String(request.data.targetEmail).trim().toLowerCase()
    : callerEmail;

  if (rawTarget !== callerEmail && !isCreator) {
    throw new HttpsError("permission-denied", "Tu ne peux supprimer que ton propre compte.");
  }

  const key = emailKey(rawTarget);
  const snap = await db.ref("users/" + key).get();
  const user = snap.val();
  if (!user) throw new HttpsError("not-found", "Compte introuvable.");
  if (user.role === "deleted") throw new HttpsError("failed-precondition", "Ce compte a déjà été supprimé.");
  if (user.role !== "coach") throw new HttpsError("permission-denied", "Cette action concerne uniquement les comptes coach.");

  // Sécurité serveur : vérifier l'absence d'athlètes encore rattachés.
  const athSnap = await db.ref("users").orderByChild("coachId").equalTo(user.id).get();
  const remaining = [];
  athSnap.forEach((c) => remaining.push(c.key));
  if (remaining.length > 0) {
    throw new HttpsError(
      "failed-precondition",
      `${remaining.length} athlète(s) encore rattaché(s) à ce coach. Réassigne-les avant de supprimer le compte.`
    );
  }

  const anonId = "del_" + (user.id || key.slice(0, 16)) + "_" + Date.now();
  const now = Date.now();

  // Archive financière sans PII (conservation légale 5 ans).
  const financialArchive = {
    anonId,
    originalId: user.id || null,
    paypalSubscriptionId: user.paypalSubscriptionId || null,
    paymentStatus: user.paymentStatus || null,
    status: user.status || null,
    deletedAt: now,
    retainUntil: now + 5 * 365 * 24 * 60 * 60 * 1000,
  };

  const updates = {};
  updates["users/" + key] = null;
  updates["deleted_accounts/" + anonId] = financialArchive;
  await db.ref().update(updates);

  // Suppression du compte Firebase Auth (Admin SDK — ne plante pas si absent).
  try {
    const authUser = await admin.auth().getUserByEmail(rawTarget);
    await admin.auth().deleteUser(authUser.uid);
  } catch (e) {
    console.warn("anonymizeCoach: Auth deletion skipped for", rawTarget, "—", e.message);
  }

  return { ok: true, anonId };
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

// ── getCloudinarySignature ───────────────────────────────────────────────────
// Génère une signature SHA1 Cloudinary pour un upload signé côté serveur.
// L'API secret ne quitte jamais le serveur — seul le hash est renvoyé au client.
// Tout utilisateur authentifié Firebase peut obtenir une signature (coaches et
// athlètes uploadent tous via Cloudinary).
exports.getCloudinarySignature = onCall(
  { secrets: [CLOUDINARY_API_SECRET, CLOUDINARY_API_KEY] },
  async (request) => {
    if (!request.auth || !request.auth.token || !request.auth.token.email) {
      throw new HttpsError("unauthenticated", "Connecte-toi pour effectuer cette action.");
    }
    const folder = String(request.data && request.data.folder || "").trim();
    const uploadPreset = String(request.data && request.data.uploadPreset || "").trim();
    const timestamp = parseInt(request.data && request.data.timestamp);
    if (!folder.startsWith("repcore/") || folder.length > 200) {
      throw new HttpsError("invalid-argument", "Dossier de destination invalide.");
    }
    if (!uploadPreset || uploadPreset.length > 100) {
      throw new HttpsError("invalid-argument", "Upload preset invalide.");
    }
    if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) {
      throw new HttpsError("invalid-argument", "Timestamp invalide ou expiré (fenêtre ±5 min).");
    }
    // Signature Cloudinary : SHA1(params triés par clé + api_secret)
    // Les paramètres qui entrent dans la signature sont exactement ceux envoyés
    // dans le FormData, hors file, resource_type, cloud_name et api_key.
    const params = { folder, timestamp, upload_preset: uploadPreset };
    const paramStr = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    const signature = crypto.createHash("sha1")
      .update(paramStr + CLOUDINARY_API_SECRET.value())
      .digest("hex");
    return { signature, timestamp, apiKey: CLOUDINARY_API_KEY.value() };
  }
);

// ── ocrParseImage ─────────────────────────────────────────────────────────────
// Proxy OCR.space — la clé API ne quitte jamais le serveur.
// Tout utilisateur Firebase authentifié peut appeler cette fonction (coaches
// et athlètes utilisent tous les deux l'import de fiche d'entraînement par photo).
exports.ocrParseImage = onCall(
  { secrets: [OCR_SPACE_API_KEY] },
  async (request) => {
    if (!request.auth || !request.auth.token || !request.auth.token.email) {
      throw new HttpsError("unauthenticated", "Connecte-toi pour effectuer cette action.");
    }
    const dataUrl = String(request.data && request.data.dataUrl || "");
    if (!dataUrl.startsWith("data:image/")) {
      throw new HttpsError("invalid-argument", "Format d'image invalide.");
    }
    // 1.5 MB base64 ≈ 1.1 MB binaire — cohérent avec la limite ~900 KB imposée côté client
    if (dataUrl.length > 1.5 * 1024 * 1024) {
      throw new HttpsError("invalid-argument", "Image trop volumineuse (max ~1 Mo après compression).");
    }
    const language = String(request.data.language || "fre").slice(0, 20);
    const isTable = request.data.isTable !== false;
    const engine = [1, 2].includes(Number(request.data.engine)) ? Number(request.data.engine) : 2;

    const body = new URLSearchParams({
      base64Image: dataUrl,
      language,
      isTable: isTable ? "true" : "false",
      scale: "true",
      OCREngine: String(engine),
      isCreateSearchablePDF: "false",
    });
    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        "apikey": OCR_SPACE_API_KEY.value(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) throw new HttpsError("internal", `Service OCR indisponible (${res.status}).`);
    const d = await res.json();
    if (d.IsErroredOnProcessing) {
      throw new HttpsError("internal", d.ErrorMessage?.[0] || "Erreur OCR.");
    }
    return { text: (d.ParsedResults?.[0]?.ParsedText || "").trim() };
  }
);

// ── togglePaymentStatus ───────────────────────────────────────────────────────
// Bascule paymentStatus (active ↔ cancelled) d'un abonné AUTONOMIE_PREMIUM.
// Autorisé uniquement pour CREATOR_EMAIL ou le coach propriétaire de l'athlète.
// Utilise l'Admin SDK pour contourner la règle RTDB (qui bloque cancelled→active
// côté client) tout en maintenant l'isolation par vérification serveur stricte.
exports.togglePaymentStatus = onCall(async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.email) {
    throw new HttpsError("unauthenticated", "Connecte-toi pour effectuer cette action.");
  }
  const callerEmail = request.auth.token.email.toLowerCase();
  const isCreator = callerEmail === CREATOR_EMAIL;

  const athleteEmail = String(request.data && request.data.athleteEmail || "").toLowerCase().trim();
  if (!athleteEmail) throw new HttpsError("invalid-argument", "athleteEmail requis.");

  // Lecture autoritaire de l'athlète depuis RTDB (jamais depuis le cache client).
  const athKey = emailKey(athleteEmail);
  const athSnap = await db.ref("users/" + athKey).get();
  const athlete = athSnap.val();
  if (!athlete || athlete.status !== "AUTONOMIE_PREMIUM") {
    throw new HttpsError("not-found", "Abonné introuvable.");
  }

  if (!isCreator) {
    // Vérification d'appartenance : le coach appelant doit être celui référencé
    // dans le profil de l'athlète — lu depuis RTDB, pas depuis le cache client.
    const callerSnap = await db.ref("users/" + emailKey(callerEmail)).get();
    const caller = callerSnap.val();
    if (!caller || caller.role !== "coach") {
      throw new HttpsError("permission-denied", "Cette action est réservée aux coachs.");
    }
    if (!athlete.coachId || caller.id !== athlete.coachId) {
      throw new HttpsError("permission-denied", "Cet athlète n'est pas dans ta liste.");
    }
  }

  const newStatus = athlete.paymentStatus === "active" ? "cancelled" : "active";
  await db.ref().update({
    [`users/${athKey}/paymentStatus`]: newStatus,
    [`users/${athKey}/updatedAt`]: Date.now(),
  });
  return { paymentStatus: newStatus };
});
