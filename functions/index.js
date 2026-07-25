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
const { initializeApp }     = require('firebase-admin/app');
const { getFirestore }      = require('firebase-admin/firestore');
const { getMessaging }      = require('firebase-admin/messaging');

initializeApp();
const db        = getFirestore();
const messaging = getMessaging();

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
