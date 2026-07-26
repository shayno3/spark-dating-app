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

// Live Stripe Price ID — Spark Premium $9.99/month
const STRIPE_PRICE_ID = 'price_1TxarFDFkYr4mQ8S5pJ9B1rP';

// App URL for Stripe return redirects
const APP_URL = 'https://spark-dating-app.pages.dev';

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
    const uid = request.auth?.uid;
    if (!uid) throw new Error('unauthenticated');

    const Stripe = require('stripe');
    const stripe = Stripe(stripeSecretKey.value());

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
    const uid = request.auth?.uid;
    if (!uid) throw new Error('unauthenticated');

    const Stripe = require('stripe');
    const stripe = Stripe(stripeSecretKey.value());

    const userSnap = await db.collection('users').doc(uid).get();
    const customerId = userSnap.data()?.stripeCustomerId;
    if (!customerId) throw new Error('No billing account found');

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: APP_URL,
    });

    return { url: session.url };
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
