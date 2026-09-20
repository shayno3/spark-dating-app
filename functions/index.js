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
const { getAuth }                = require('firebase-admin/auth');
const { getStorage }             = require('firebase-admin/storage');

initializeApp();
const db        = getFirestore();
const messaging = getMessaging();

// Firebase Secret Manager bindings
const stripeSecretKey     = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
const openAiKey           = defineSecret('OPENAI_API_KEY');
const resendKey           = defineSecret('RESEND_API_KEY');

// TEST Stripe Price ID — Spark Premium $9.99/month (test mode)
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
      if (!keyVal || !keyVal.startsWith('sk_')) {
        console.error('createCheckoutSession: STRIPE_SECRET_KEY is missing or invalid (must start with sk_test_ or sk_live_)');
        throw new HttpsError('internal', 'Payment service is not configured. Please contact support.', 'Payment service is not configured. Please contact support.');
      }
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
      const rawMsg = err?.raw?.message || err?.message || 'Unable to start checkout. Please try again.';
      console.error('createCheckoutSession error:', JSON.stringify({ msg: rawMsg, type: err?.type, code: err?.statusCode }));
      // Never expose raw Stripe API key errors to users — sanitize the user-facing message
      const isAuthErr = err?.type === 'StripeAuthenticationError' || rawMsg.toLowerCase().includes('api key');
      const userMsg = isAuthErr
        ? 'Payment service is not configured. Please contact support.'
        : 'Checkout unavailable — please try again or contact support.';
      throw new HttpsError('internal', userMsg, userMsg);
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
      if (!keyVal || !keyVal.startsWith('sk_')) {
        console.error('createPortalSession: STRIPE_SECRET_KEY is missing or invalid (must start with sk_test_ or sk_live_)');
        throw new HttpsError('internal', 'Payment service is not configured. Please contact support.', 'Payment service is not configured. Please contact support.');
      }
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
      const rawMsg = err?.raw?.message || err?.message || 'Unable to open billing portal. Please try again.';
      console.error('createPortalSession error:', JSON.stringify({ msg: rawMsg, type: err?.type, code: err?.statusCode }));
      // Never expose raw Stripe API key errors to users
      const isAuthErr = err?.type === 'StripeAuthenticationError' || rawMsg.toLowerCase().includes('api key');
      const userMsg = isAuthErr
        ? 'Payment service is not configured. Please contact support.'
        : 'Unable to open billing portal — please try again or contact support.';
      throw new HttpsError('internal', userMsg, userMsg);
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

/* ----------------------------------------------------------------
   ADMIN — hardDeleteUser
   Callable by admin only. Fully purges a user — ALL Firestore data
   (matches, messages, likes, user doc) + Storage + Auth account.
   Admin SDK bypasses Firestore security rules entirely.
---------------------------------------------------------------- */
const ADMIN_UID = 'qwDw0vp4suOugIr39GqJ0K70cIq2'; // Spark admin uid
exports.hardDeleteUser = onCall(async (request) => {
  const { HttpsError } = require('firebase-functions/v2/https');

  // Only the admin account may call this
  if (request.auth?.uid !== ADMIN_UID) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }

  const targetUid = request.data?.uid;
  if (!targetUid || typeof targetUid !== 'string') {
    throw new HttpsError('invalid-argument', 'A valid uid is required.');
  }
  if (targetUid === ADMIN_UID) {
    throw new HttpsError('invalid-argument', 'Cannot delete the admin account.');
  }

  const log = (...a) => console.log('[hardDeleteUser]', ...a);

  // Firestore batch helper (max 500 ops/batch)
  const batches    = [db.batch()];
  let   opCount    = 0;
  const batchDel   = (ref) => {
    if (opCount >= 490) { batches.push(db.batch()); opCount = 0; }
    batches[batches.length - 1].delete(ref);
    opCount++;
  };

  try {
    // 1. Matches + messages sub-collections
    const matchSnap = await db.collection('matches')
      .where('uids', 'array-contains', targetUid).get();
    for (const mDoc of matchSnap.docs) {
      const msgSnap = await db.collection('messages')
        .doc(mDoc.id).collection('msgs').get();
      msgSnap.docs.forEach(m => batchDel(m.ref));
      batchDel(mDoc.ref);
    }
    log(`Queued ${matchSnap.size} matches for deletion.`);

    // 2. Likes sent by this user (and mirror received docs on other users)
    const sentSnap = await db.collection('likes')
      .doc(targetUid).collection('sent').get();
    for (const sd of sentSnap.docs) {
      batchDel(db.collection('likes').doc(sd.id).collection('received').doc(targetUid));
      batchDel(sd.ref);
    }
    if (sentSnap.size > 0) batchDel(db.collection('likes').doc(targetUid));
    log(`Queued ${sentSnap.size} sent likes.`);

    // 3. Likes received by this user (and mirror sent docs on other users)
    const recvSnap = await db.collection('likes')
      .doc(targetUid).collection('received').get();
    for (const rd of recvSnap.docs) {
      batchDel(db.collection('likes').doc(rd.id).collection('sent').doc(targetUid));
      batchDel(rd.ref);
    }
    log(`Queued ${recvSnap.size} received likes.`);

    // 4. User document
    batchDel(db.collection('users').doc(targetUid));

    // Commit all Firestore batches
    await Promise.all(batches.map(b => b.commit()));
    log('Firestore cleanup complete.');

    // 5. Storage — delete all folders for this user
    const bucket = getStorage().bucket();
    const delFolder = async (prefix) => {
      try {
        const [files] = await bucket.getFiles({ prefix });
        await Promise.all(files.map(f => f.delete().catch(() => {})));
        log(`Deleted ${files.length} files under storage:${prefix}`);
      } catch (e) {
        log(`Storage folder ${prefix} error (ignored):`, e.message);
      }
    };
    await Promise.all([
      delFolder(`photos/${targetUid}/`),
      delFolder(`voice/${targetUid}/`),
      delFolder(`verifications/${targetUid}/`),
    ]);
    log('Storage cleanup complete.');

    // 6. Firebase Auth account — must be last
    try {
      await getAuth().deleteUser(targetUid);
      log(`Auth account deleted for ${targetUid}`);
    } catch (authErr) {
      if (authErr.code === 'auth/user-not-found') {
        log('Auth account was already deleted — continuing.');
      } else {
        // Auth deletion failed, but Firestore + Storage are already gone — log and continue
        console.error('[hardDeleteUser] Auth deletion failed:', authErr.message);
      }
    }

    log(`Full purge complete for uid: ${targetUid}, requested by: ${request.auth.uid}`);
    return { success: true };

  } catch (err) {
    console.error('[hardDeleteUser] Fatal error:', err);
    throw new HttpsError('internal', 'Hard delete failed: ' + err.message);
  }
});

/* ----------------------------------------------------------------
   ADMIN — sendAdminEmail
   Callable by admin only. Sends a transactional email to a user
   via Resend (resend.com — free tier: 3,000 emails/month, no CC).
   Appears from "Spark Team <noreply@smartsparks.app>".

   Setup (one-time):
     1. Create a free account at resend.com
     2. Add domain "smartsparks.app" → Domains → Add Domain
        (Adds 3 DNS records in Cloudflare — ~2 min to verify)
     3. Create an API key (API Keys → Create API Key)
     4. Store it:  firebase functions:secrets:set RESEND_API_KEY
     5. Deploy:    firebase deploy --only functions

   Called from admin panel with: { uid, subject, body }
---------------------------------------------------------------- */
exports.sendAdminEmail = onCall(
  { secrets: [resendKey] },
  async (request) => {
    const { HttpsError } = require('firebase-functions/v2/https');

    // Only the admin account may call this
    if (request.auth?.uid !== ADMIN_UID) {
      throw new HttpsError('permission-denied', 'Admin access required.');
    }

    const { uid, subject, body } = request.data || {};
    if (!uid || !subject || !body) {
      throw new HttpsError('invalid-argument', 'uid, subject, and body are required.');
    }

    // Fetch the user's email from Firebase Auth (most reliable source)
    let recipientEmail;
    try {
      const authUser = await getAuth().getUser(uid);
      recipientEmail = authUser.email;
    } catch (e) {
      throw new HttpsError('not-found', 'User not found in Firebase Auth.');
    }
    if (!recipientEmail) {
      throw new HttpsError('not-found', 'This user has no email address on file.');
    }

    const htmlBody = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    // Send via Resend
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey.value()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Spark Team <noreply@smartsparks.app>',
        to:   [recipientEmail],
        subject,
        text: body,
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#111827">
            <div style="background:linear-gradient(135deg,#e11d48,#9333ea);padding:28px 32px;border-radius:12px 12px 0 0">
              <h1 style="margin:0;color:#fff;font-size:1.5rem;letter-spacing:-0.02em">✨ Spark</h1>
            </div>
            <div style="background:#fff;padding:32px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none">
              <p style="margin:0 0 1.25rem;font-size:1rem;line-height:1.6;color:#374151">${htmlBody}</p>
              <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb">
              <p style="margin:0;font-size:0.8rem;color:#9ca3af">
                You're receiving this message because you have an account on
                <a href="https://smartsparks.app" style="color:#e11d48;text-decoration:none">Spark</a>.
              </p>
            </div>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error('[sendAdminEmail] Resend error:', errBody);
      throw new HttpsError('internal', 'Email send failed: ' + (errBody?.message || res.statusText));
    }

    const data = await res.json();
    console.log(`[sendAdminEmail] Sent to ${recipientEmail} (uid: ${uid}), subject: "${subject}", id: ${data.id}`);
    return { success: true, email: recipientEmail };
  }
);
