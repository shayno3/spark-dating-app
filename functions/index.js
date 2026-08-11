/**
 * Spark Dating App — Firebase Cloud Functions
 *
 * These functions send FCM push notifications when:
 *   1. A new like is received         →  notify the liked user
 *   2. A new match document is created  →  notify both users
 *   3. A new message (msgs sub-doc) is created  →  notify the other user
 *
 * DEPLOY REQUIREMENTS:
 *   • Firebase Blaze (pay-as-you-go) plan — free tier covers ~2M invocations/month.
 *   • Node.js 18+
 *   • Run from this folder:
 *       npm install
 *       firebase deploy --only functions
 *
 * SETUP STEPS (one-time):
 *   1. firebase login
 *   2. firebase use spark-dating-c74f4
 *   3. cd functions && npm install && cd ..
 *   4. firebase deploy --only functions
 */

const { onDocumentCreated }      = require('firebase-functions/v2/firestore');
const { onCall, onRequest }      = require('firebase-functions/v2/https');
const { defineSecret }           = require('firebase-functions/params');
const { initializeApp }          = require('firebase-admin/app');
const { getFirestore }           = require('firebase-admin/firestore');
const { getMessaging }           = require('firebase-admin/messaging');

initializeApp();
const db        = getFirestore();
const messaging = getMessaging();

// Firebase Secret Manager bindings
const stripeSecretKey     = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
const openAiKey           = defineSecret('OPENAI_API_KEY');

// Live Stripe Price ID — Spark Premium $9.99/month
const STRIPE_PRICE_ID = 'price_1TxarFDFkYr4mQ8S5pJ9B1rP';

// App URL for Stripe return redirects
const APP_URL = 'https://smartsparks.app';

/* ----------------------------------------------------------------
   Helper — fetch FCM tokens for a user uid, skip if none stored.
---------------------------------------------------------------- */
async function getTokensForUser(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return [];
  return (snap.data().fcmTokens || []).filter(Boolean);
}

/* ----------------------------------------------------------------
   Helper — send a multicast message, pruning stale tokens.
---------------------------------------------------------------- */
async function sendAndPrune(uid, message) {
  const tokens = await getTokensForUser(uid);
  if (!tokens.length) return;

  const response = await messaging.sendEachForMulticast({ tokens, ...message });

  // Remove tokens that are no longer valid (unregistered / invalid).
  const stale = [];
  response.responses.forEach((r, i) => {
    if (!r.success && (
      r.error?.code === 'messaging/registration-token-not-registered' ||
      r.error?.code === 'messaging/invalid-registration-token'
    )) {
      stale.push(tokens[i]);
    }
  });
  if (stale.length) {
    await db.collection('users').doc(uid).update({
      fcmTokens: require('firebase-admin/firestore').FieldValue.arrayRemove(...stale)
    });
  }
}

/* ----------------------------------------------------------------
   TRIGGER 1 — New like received
   likes/{senderUid}/sent/{targetUid}  { action: 'like'|'super', ts: ... }
   Notify the target (liked) user — but NOT if it creates a match
   (onNewMatch already handles that case with a better message).
---------------------------------------------------------------- */
exports.onNewLike = onDocumentCreated('likes/{senderUid}/sent/{targetUid}', async (event) => {
  const data      = event.data?.data();
  if (!data) return;

  const senderUid = event.params.senderUid;
  const targetUid = event.params.targetUid;
  const isSuper   = data.action === 'super';

  // Check if this like creates a match (target already liked sender back).
  // If so, skip — onNewMatch will fire a richer "It's a Spark!" notification.
  const reverseSnap = await db.collection('likes').doc(targetUid).collection('sent').doc(senderUid).get();
  if (reverseSnap.exists) return; // mutual like — let onNewMatch handle it

  // Sender's name for the notification body.
  const senderSnap = await db.collection('users').doc(senderUid).get();
  const senderName = senderSnap.data()?.name || 'Someone';

  const title = isSuper ? '⭐ Super Like!' : '❤️ Someone likes you!';
  const body  = isSuper
    ? `${senderName} sent you a Super Like — check them out!`
    : `${senderName} liked your profile — like them back?`;

  await sendAndPrune(targetUid, {
    notification: { title, body },
    data: { type: 'like', senderUid, url: '/' },
    webpush: {
      headers: { Urgency: 'normal' },
      fcmOptions: { link: '/' },
    },
  });
});

/* ----------------------------------------------------------------
   TRIGGER 2 — New match created
   matches/{matchId}  { uids: [uid1, uid2], ... }
   Notify both participants.
---------------------------------------------------------------- */
exports.onNewMatch = onDocumentCreated('matches/{matchId}', async (event) => {
  const data = event.data?.data();
  if (!data) return;

  const uids = data.uids || [];
  if (uids.length < 2) return;

  // Fetch both users' names for a personalised notification.
  const [snapA, snapB] = await Promise.all([
    db.collection('users').doc(uids[0]).get(),
    db.collection('users').doc(uids[1]).get(),
  ]);
  const nameA = snapA.data()?.name || 'Someone';
  const nameB = snapB.data()?.name || 'Someone';

  // Notify user A → "You matched with <nameB>!"
  await sendAndPrune(uids[0], {
    notification: {
      title: '✨ It\'s a Spark!',
      body:  `You matched with ${nameB} — say hello!`,
    },
    data: { type: 'match', matchId: event.params.matchId, url: '/' },
    webpush: {
      headers: { Urgency: 'high' },
      fcmOptions: { link: '/' },
    },
  });

  // Notify user B → "You matched with <nameA>!"
  await sendAndPrune(uids[1], {
    notification: {
      title: '✨ It\'s a Spark!',
      body:  `You matched with ${nameA} — say hello!`,
    },
    data: { type: 'match', matchId: event.params.matchId, url: '/' },
    webpush: {
      headers: { Urgency: 'high' },
      fcmOptions: { link: '/' },
    },
  });
});

/* ----------------------------------------------------------------
   STRIPE — createCheckoutSession
   Called by the frontend to start a Stripe Checkout for Spark Premium.
   Returns { url } — the hosted Checkout page URL.
---------------------------------------------------------------- */
exports.createCheckoutSession = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    const { HttpsError } = require('firebase-functions/v2/https');

    try {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError('unauthenticated', 'You must be logged in to subscribe.', 'You must be logged in to subscribe.');

      const Stripe = require('stripe');
      const keyVal = stripeSecretKey.value();
      if (!keyVal) throw new HttpsError('internal', 'Stripe secret key is not configured.', 'Stripe secret key is not configured.');
      const stripe = new Stripe(keyVal);

      // Look up the user's Stripe customer ID, or create one.
      const userSnap = await db.collection('users').doc(uid).get();
      const userData = userSnap.data() || {};
      let customerId = userData.stripeCustomerId;

      if (!customerId) {
        const customer = await stripe.customers.create({
          metadata: { firebaseUid: uid },
          email: userData.email || undefined,
          name:  userData.name  || undefined,
        });
        customerId = customer.id;
        await db.collection('users').doc(uid).update({ stripeCustomerId: customerId });
      }

      const session = await stripe.checkout.sessions.create({
        customer:   customerId,
        mode:       'subscription',
        line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
        success_url: `${APP_URL}/?checkout=success`,
        cancel_url:  `${APP_URL}/?checkout=cancel`,
      });

      return { url: session.url };
    } catch (err) {
      // Re-throw HttpsErrors (unauthenticated, our own internal, etc.) as-is
      if (err instanceof require('firebase-functions/v2/https').HttpsError) throw err;
      const msg = err?.raw?.message || err?.message || 'Unable to start checkout. Please try again.';
      console.error('createCheckoutSession error:', JSON.stringify({ msg, type: err?.type, code: err?.statusCode }));
      // Pass msg as details (3rd arg) so client can always read it via e.details
      throw new HttpsError('internal', msg, msg);
    }
  }
);

/* ----------------------------------------------------------------
   STRIPE — createPortalSession
   Called by the frontend to open the Stripe Billing Portal.
   Returns { url } — the portal URL.
---------------------------------------------------------------- */
exports.createPortalSession = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    const { HttpsError } = require('firebase-functions/v2/https');

    try {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError('unauthenticated', 'You must be logged in.', 'You must be logged in.');

      const Stripe = require('stripe');
      const keyVal = stripeSecretKey.value();
      if (!keyVal) throw new HttpsError('internal', 'Stripe secret key is not configured.', 'Stripe secret key is not configured.');
      const stripe = new Stripe(keyVal);

      const userSnap = await db.collection('users').doc(uid).get();
      const customerId = userSnap.data()?.stripeCustomerId;
      if (!customerId) throw new HttpsError('not-found', 'No billing account found. Subscribe first.', 'No billing account found. Subscribe first.');

      const session = await stripe.billingPortal.sessions.create({
        customer:   customerId,
        return_url: APP_URL,
      });

      return { url: session.url };
    } catch (err) {
      // Re-throw HttpsErrors as-is
      if (err instanceof require('firebase-functions/v2/https').HttpsError) throw err;
      const msg = err?.raw?.message || err?.message || 'Unable to open billing portal. Please try again.';
      console.error('createPortalSession error:', JSON.stringify({ msg, type: err?.type, code: err?.statusCode }));
      throw new HttpsError('internal', msg, msg);
    }
  }
);

/* ----------------------------------------------------------------
   STRIPE — stripeWebhook
   Receives Stripe events (subscription created/updated/deleted)
   and keeps users.isPremium in sync in Firestore.
---------------------------------------------------------------- */
exports.stripeWebhook = onRequest(
  { secrets: [stripeSecretKey, stripeWebhookSecret] },
  async (req, res) => {
    const Stripe = require('stripe');
    const stripe = Stripe(stripeSecretKey.value());

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        stripeWebhookSecret.value()
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const subscription = event.data.object;

    // Map Stripe customer → Firebase UID
    async function getUidForCustomer(customerId) {
      const snap = await db.collection('users')
        .where('stripeCustomerId', '==', customerId)
        .limit(1)
        .get();
      return snap.empty ? null : snap.docs[0].id;
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const uid = await getUidForCustomer(subscription.customer);
        if (uid) {
          const isPremium = ['active', 'trialing'].includes(subscription.status);
          await db.collection('users').doc(uid).update({
            isPremium,
            stripeSubscriptionId:     subscription.id,
            stripeSubscriptionStatus: subscription.status,
          });
          console.log(`User ${uid} isPremium=${isPremium} (status: ${subscription.status})`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const uid = await getUidForCustomer(subscription.customer);
        if (uid) {
          await db.collection('users').doc(uid).update({
            isPremium: false,
            stripeSubscriptionStatus: 'canceled',
          });
          console.log(`User ${uid} isPremium=false (subscription cancelled)`);
        }
        break;
      }
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

/* ----------------------------------------------------------------
   TRANSLATE VOICE NOTE  (Premium-only, on-demand)
   Called by the frontend with { matchId, msgId }.
   1. Verifies the caller is authenticated & isPremium.
   2. Verifies the caller is a participant in that match.
   3. Returns a cached translation if one already exists.
   4. Downloads the voice note audio, sends it to OpenAI Whisper
      /v1/audio/translations (returns English text), caches the
      result back on the message doc, and returns it to the client.
---------------------------------------------------------------- */
exports.translateVoiceNote = onCall(
  { secrets: [openAiKey] },
  async (request) => {
    const { HttpsError } = require('firebase-functions/v2/https');

    // 1. Auth
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'You must be logged in.', 'You must be logged in.');

    // 2. Premium check — enforce server-side so it cannot be bypassed
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists || !userSnap.data().isPremium) {
      throw new HttpsError(
        'permission-denied',
        'Voice note translation is a Premium feature.',
        'Voice note translation is a Premium feature. Upgrade to unlock!'
      );
    }

    const { matchId, msgId } = request.data || {};
    if (!matchId || !msgId) {
      throw new HttpsError('invalid-argument', 'matchId and msgId are required.', 'Invalid request — please try again.');
    }

    // 3. Verify the caller is in this match
    const matchSnap = await db.collection('matches').doc(matchId).get();
    if (!matchSnap.exists) throw new HttpsError('not-found', 'Match not found.', 'Match not found.');
    if (!(matchSnap.data().uids || []).includes(uid)) {
      throw new HttpsError('permission-denied', 'Not authorised.', 'Not authorised.');
    }

    // 4. Get the message doc
    const msgRef  = db.collection('messages').doc(matchId).collection('msgs').doc(msgId);
    const msgSnap = await msgRef.get();
    if (!msgSnap.exists) throw new HttpsError('not-found', 'Message not found.', 'Message not found.');
    const msgData = msgSnap.data();

    // 5. Return cached translation immediately if available
    if (msgData.translation) return { translation: msgData.translation };

    if (msgData.type !== 'voiceNote' || !msgData.audioUrl) {
      throw new HttpsError('invalid-argument', 'Not a voice note.', 'This message is not a voice note.');
    }

    // 6. Download the audio (supports Firebase Storage URLs and base64 data URLs)
    const audioUrl = msgData.audioUrl;
    let audioBuffer;
    let mimeType = 'audio/webm';

    if (audioUrl.startsWith('data:')) {
      // Base64 data URL — extract MIME type and decode bytes
      const [header, b64] = audioUrl.split(',');
      mimeType = header.split(':')[1]?.split(';')[0] || 'audio/webm';
      audioBuffer = Buffer.from(b64, 'base64');
    } else {
      // Remote URL (Firebase Storage download URL)
      const dlRes = await fetch(audioUrl);
      if (!dlRes.ok) throw new HttpsError('internal', 'Could not download audio.', 'Could not download audio — please try again.');
      audioBuffer = Buffer.from(await dlRes.arrayBuffer());
    }

    // 7. Determine file extension for Whisper (must be a supported format)
    const ext = mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
              : mimeType.includes('ogg') ? 'ogg'
              : mimeType.includes('wav') ? 'wav'
              : 'webm';

    // 8. Call OpenAI Whisper /v1/audio/translations — detects the source language
    //    automatically and always returns the transcript in English.
    const apiKey = openAiKey.value();
    if (!apiKey) throw new HttpsError('internal', 'Translation service not configured.', 'Translation service not configured.');

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/translations', {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body:    form,
    });

    if (!whisperRes.ok) {
      const errBody = await whisperRes.text();
      console.error('Whisper API error:', errBody);
      throw new HttpsError('internal', 'Translation failed — please try again.', 'Translation failed — please try again.');
    }

    const translation = (await whisperRes.text()).trim();
    if (!translation) throw new HttpsError('internal', 'Empty translation returned.', 'Could not translate this voice note.');

    // 9. Cache on the message doc so repeat taps are instant & free
    await msgRef.update({ translation }).catch(() => {});

    return { translation };
  }
);

/* ----------------------------------------------------------------
   TRIGGER 3 — New message sent
   messages/{matchId}/msgs/{msgId}  { from: uid, text: string }
   Notify the OTHER participant.
---------------------------------------------------------------- */
exports.onNewMessage = onDocumentCreated('messages/{matchId}/msgs/{msgId}', async (event) => {
  const data = event.data?.data();
  if (!data) return;

  const senderUid = data.from;
  const text      = data.text || '';
  const type      = data.type || '';
  const matchId   = event.params.matchId;

  // Look up the match to find the recipient.
  const matchSnap = await db.collection('matches').doc(matchId).get();
  if (!matchSnap.exists) return;

  const uids      = matchSnap.data().uids || [];
  const recipient = uids.find(uid => uid !== senderUid);
  if (!recipient) return;

  // Sender's name for the notification body.
  const senderSnap = await db.collection('users').doc(senderUid).get();
  const senderName = senderSnap.data()?.name || 'Your match';

  // M3: correct preview for voice notes
  const preview = type === 'voiceNote'
    ? '🎙 Voice note'
    : text.length > 60 ? text.slice(0, 57) + '…' : text;

  await sendAndPrune(recipient, {
    notification: {
      title: `💬 ${senderName}`,
      body:  preview || '🎙 Voice note',
    },
    data: { type: 'message', matchId, url: '/' },
    webpush: {
      headers: { Urgency: 'high' },
      fcmOptions: { link: '/' },
    },
  });
});
