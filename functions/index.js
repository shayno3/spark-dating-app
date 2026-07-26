// v2 — stripe support
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

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }      = require('firebase-functions/params');
const { initializeApp }     = require('firebase-admin/app');
const { getFirestore }      = require('firebase-admin/firestore');
const { getMessaging }      = require('firebase-admin/messaging');

initializeApp();
const db        = getFirestore();
const messaging = getMessaging();

/* ----------------------------------------------------------------
   Stripe secrets — stored in Firebase Secret Manager, never in code.
   Set them once with:
     firebase functions:secrets:set STRIPE_SECRET_KEY
     firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
---------------------------------------------------------------- */
const STRIPE_SECRET_KEY     = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

/* Your Stripe Price ID for Spark Premium $9.99/mo (Test Mode) */
const STRIPE_PRICE_ID = 'price_1TxTYKDFkYr4mQ8SAyC7K2Yl';
const APP_URL         = 'https://spark-dating-d16.pages.dev';

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
   TRIGGER 3 — New message sent
   messages/{matchId}/msgs/{msgId}  { from: uid, text: string }
   Notify the OTHER participant.
---------------------------------------------------------------- */
exports.onNewMessage = onDocumentCreated('messages/{matchId}/msgs/{msgId}', async (event) => {
  const data = event.data?.data();
  if (!data) return;

  const senderUid = data.from;
  const text      = data.text || '';
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

  const preview = text.length > 60 ? text.slice(0, 57) + '…' : text;

  await sendAndPrune(recipient, {
    notification: {
      title: `💬 ${senderName}`,
      body:  preview || '(photo)',
    },
    data: { type: 'message', matchId, url: '/' },
    webpush: {
      headers: { Urgency: 'high' },
      fcmOptions: { link: '/' },
    },
  });
});

/* ================================================================
   STRIPE — SUBSCRIPTION FUNCTIONS
================================================================ */

/* ----------------------------------------------------------------
   FUNCTION 4 — createCheckoutSession
   Called from the app when user taps "Get Premium".
   Creates a Stripe Checkout session and returns the redirect URL.
---------------------------------------------------------------- */
exports.createCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');

    const Stripe     = require('stripe');
    const stripe     = Stripe(STRIPE_SECRET_KEY.value());
    const uid        = request.auth.uid;
    const email      = request.auth.token.email || '';

    // Re-use existing Stripe customer if one already exists for this user
    const userDoc    = await db.collection('users').doc(uid).get();
    let customerId   = userDoc.data()?.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { firebaseUid: uid },
      });
      customerId = customer.id;
      await db.collection('users').doc(uid).update({ stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ['card'],
      mode:                 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${APP_URL}/?checkout=success`,
      cancel_url:  `${APP_URL}/?checkout=cancel`,
    });

    return { url: session.url };
  }
);

/* ----------------------------------------------------------------
   FUNCTION 5 — stripeWebhook
   Stripe calls this on subscription events.
   Keeps Firestore isPremium in sync with the real subscription state.
---------------------------------------------------------------- */
exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const Stripe = require('stripe');
    const stripe = Stripe(STRIPE_SECRET_KEY.value());

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub      = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const uid      = customer.metadata?.firebaseUid;
        if (!uid) break;

        const isActive = ['active', 'trialing'].includes(sub.status);
        await db.collection('users').doc(uid).update({
          isPremium:                isActive,
          stripeSubscriptionId:     sub.id,
          stripeSubscriptionStatus: sub.status,
          premiumExpiresAt:         new Date(sub.current_period_end * 1000),
        });
        console.log(`User ${uid} isPremium → ${isActive} (${sub.status})`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub      = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const uid      = customer.metadata?.firebaseUid;
        if (!uid) break;

        await db.collection('users').doc(uid).update({
          isPremium:                false,
          stripeSubscriptionStatus: 'canceled',
        });
        console.log(`User ${uid} subscription canceled — isPremium → false`);
        break;
      }

      default:
        // Ignore other event types
        break;
    }

    res.json({ received: true });
  }
);

/* ----------------------------------------------------------------
   FUNCTION 6 — createPortalSession
   Lets users manage or cancel their subscription via Stripe's
   hosted billing portal — no UI to build on your end.
---------------------------------------------------------------- */
exports.createPortalSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');

    const Stripe     = require('stripe');
    const stripe     = Stripe(STRIPE_SECRET_KEY.value());
    const userDoc    = await db.collection('users').doc(request.auth.uid).get();
    const customerId = userDoc.data()?.stripeCustomerId;

    if (!customerId) {
      throw new HttpsError('not-found', 'No billing account found for this user');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: APP_URL,
    });

    return { url: session.url };
  }
);
