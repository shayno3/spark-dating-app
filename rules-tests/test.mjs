// Spark Firestore rules tests — LOCAL EMULATOR ONLY (project "demo-spark"; nothing touches production).
// Run from this folder:  npm install && npm test
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where,
         serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore';

const ADMIN = 'qwDw0vp4suOugIr39GqJ0K70cIq2', A = 'userA', B = 'userB', C = 'userC';
const env = await initializeTestEnvironment({
  projectId: 'demo-spark',
  firestore: { rules: readFileSync('../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
});
const as  = uid => env.authenticatedContext(uid).firestore();
const anon = env.unauthenticatedContext().firestore();
const seed = fn => env.withSecurityRulesDisabled(c => fn(c.firestore()));
const days = n => Timestamp.fromMillis(Date.now() + n * 86400e3);
const results = []; let failed = 0;
async function t(name, p) { try { await p; results.push('PASS  ' + name); } catch (e) { failed++; results.push('FAIL  ' + name + '  ::  ' + String(e.message || e).slice(0, 140)); } }
const vote = (rater, target, v = 'fire', extra = {}) => ({ raterId: rater, targetId: target, vote: v, createdAt: serverTimestamp(), ...extra });

// ───────────────────────── Fire or Ice ratings ─────────────────────────
await t('rate: create own vote at fixed ID {rater}_{target}', assertSucceeds(setDoc(doc(as(A), 'fireIceRatings', `${A}_${B}`), vote(A, B))));
await t('rate: re-vote same person = update own doc (fire → ice)', assertSucceeds(setDoc(doc(as(A), 'fireIceRatings', `${A}_${B}`), vote(A, B, 'ice'))));
await t('rate: random-ID add() denied (no duplicate votes)', assertFails(addDoc(collection(as(A), 'fireIceRatings'), vote(A, C))));
await t('rate: wrong fixed ID denied', assertFails(setDoc(doc(as(A), 'fireIceRatings', `${A}_${C}`), vote(A, B))));
await t('rate: voting as someone else denied', assertFails(setDoc(doc(as(A), 'fireIceRatings', `${B}_${C}`), vote(B, C))));
await t('rate: self-rating denied', assertFails(setDoc(doc(as(A), 'fireIceRatings', `${A}_${A}`), vote(A, A))));
await t('rate: invalid vote value denied', assertFails(setDoc(doc(as(A), 'fireIceRatings', `${A}_${C}`), vote(A, C, 'lava'))));
await t('rate: extra field denied', assertFails(setDoc(doc(as(A), 'fireIceRatings', `${A}_${C}`), vote(A, C, 'fire', { score: 999 }))));
await t('rate: fake createdAt (not server time) denied', assertFails(setDoc(doc(as(A), 'fireIceRatings', `${A}_${C}`), { raterId: A, targetId: C, vote: 'fire', createdAt: Timestamp.fromMillis(0) })));
await t('rate: signed-out denied', assertFails(setDoc(doc(anon, 'fireIceRatings', `${A}_${C}`), vote(A, C))));
await t('rate: B cannot hijack A\'s vote doc', assertFails(setDoc(doc(as(B), 'fireIceRatings', `${A}_${B}`), vote(B, B))));
await t('rate: non-admin delete denied', assertFails(deleteDoc(doc(as(A), 'fireIceRatings', `${A}_${B}`))));
await seed(async db => { await setDoc(doc(db, 'fireIceRatings', 'legacyRandomId1'), { raterId: C, targetId: A, vote: 'ice', createdAt: Timestamp.now() }); });
await t('rate: read my received votes (Spark Score query)', assertSucceeds(getDocs(query(collection(as(A), 'fireIceRatings'), where('targetId', '==', A)))));
await t('rate: read my given votes (Fire or Ice "already rated" query)', assertSucceeds(getDocs(query(collection(as(A), 'fireIceRatings'), where('raterId', '==', A)))));
await t('rate: legacy random-ID vote still readable by its target', assertSucceeds(getDoc(doc(as(A), 'fireIceRatings', 'legacyRandomId1'))));
await t('rate: cannot read someone else\'s received votes', assertFails(getDocs(query(collection(as(C), 'fireIceRatings'), where('targetId', '==', B)))));
await t('rate: cannot list the whole collection', assertFails(getDocs(collection(as(C), 'fireIceRatings'))));
await t('rate: admin can read everything', assertSucceeds(getDocs(collection(as(ADMIN), 'fireIceRatings'))));
await t('rate: admin can delete', assertSucceeds(deleteDoc(doc(as(ADMIN), 'fireIceRatings', 'legacyRandomId1'))));

// ───────────────────────── Users ─────────────────────────
const placeholder = { name: 'New', email: 'n@x.com', phone: '', status: 'incomplete', photos: [], online: false, createdAt: serverTimestamp() };
await t('users: signup placeholder create (as the app does)', assertSucceeds(setDoc(doc(as('newU'), 'users', 'newU'), placeholder, { merge: true })));
await t('users: setup-wizard profile save', assertSucceeds(setDoc(doc(as('newU'), 'users', 'newU'), { name: 'New', age: 30, city: 'X', state: 'NC', bio: 'hi', interests: [], photos: ['a'], online: true, createdAt: serverTimestamp() })));
await t('users: create with isPremium:true denied', assertFails(setDoc(doc(as('evil1'), 'users', 'evil1'), { name: 'E', isPremium: true })));
await t('users: create with banned field denied', assertFails(setDoc(doc(as('evil2'), 'users', 'evil2'), { name: 'E', banned: false })));
await t('users: create with Founder\'s Access in 2099 denied', assertFails(setDoc(doc(as('evil3'), 'users', 'evil3'), { name: 'E', founderAccessExpiry: days(27000) })));
await t('users: create for another uid denied', assertFails(setDoc(doc(as(A), 'users', 'someoneElse'), { name: 'X' })));
await seed(async db => { await setDoc(doc(db, 'users', A), { name: 'A', photos: [] }); await setDoc(doc(db, 'users', B), { name: 'B', banned: true, photos: [] }); });
await t('users: first-login Founder\'s Access stamp (30 days) allowed', assertSucceeds(updateDoc(doc(as(A), 'users', A), { founderAccessExpiry: days(30) })));
await t('users: extending Founder\'s Access afterwards denied', assertFails(updateDoc(doc(as(A), 'users', A), { founderAccessExpiry: days(3650) })));
await seed(async db => { await setDoc(doc(db, 'users', C), { name: 'C', photos: [] }); });
await t('users: first Founder\'s stamp longer than 31 days denied', assertFails(updateDoc(doc(as(C), 'users', C), { founderAccessExpiry: days(90) })));
await t('users: self-unban denied', assertFails(updateDoc(doc(as(B), 'users', B), { banned: false })));
await t('users: self-grant isPremium denied (existing protection)', assertFails(updateDoc(doc(as(A), 'users', A), { isPremium: true })));
await t('users: normal profile edit (bio/photos) allowed', assertSucceeds(updateDoc(doc(as(A), 'users', A), { bio: 'new bio', photos: ['1', '2'] })));
await t('users: 7 photos denied (existing cap)', assertFails(updateDoc(doc(as(A), 'users', A), { photos: ['1','2','3','4','5','6','7'] })));
await t('users: self-verify allowed (app auto-verifies)', assertSucceeds(updateDoc(doc(as(A), 'users', A), { verified: true, verificationStatus: 'verified' })));
await t('users: self delete-mark allowed (Delete Account)', assertSucceeds(updateDoc(doc(as(A), 'users', A), { deleted: true, invisible: true, online: false })));
await t('users: admin ban allowed', assertSucceeds(updateDoc(doc(as(ADMIN), 'users', C), { banned: true })));
await t('users: admin unban allowed', assertSucceeds(updateDoc(doc(as(ADMIN), 'users', B), { banned: false })));
await t('users: another user bumps profileViewsWeekly (existing)', assertSucceeds(updateDoc(doc(as(C), 'users', A), { profileViewsWeekly: 3 })));
await t('users: signed-in read profiles', assertSucceeds(getDoc(doc(as(C), 'users', A))));

// ───────────────────────── Regression smoke (unchanged sections) ─────────────────────────
const mid = [A, B].sort().join('_');
await t('matches: participant creates match', assertSucceeds(setDoc(doc(as(A), 'matches', mid), { uids: [A, B] })));
await t('matches: participant sets clearedAt (Delete Conversation)', assertSucceeds(updateDoc(doc(as(A), 'matches', mid), { ['clearedAt_' + A]: serverTimestamp() })));
await t('messages: participant sends message', assertSucceeds(setDoc(doc(as(A), 'messages', mid, 'msgs', 'm1'), { from: A, text: 'hi', ts: serverTimestamp() })));
await t('messages: outsider cannot read', assertFails(getDoc(doc(as(C), 'messages', mid, 'msgs', 'm1'))));
await t('matches: participant Unmatch batch (msgs + match)', assertSucceeds((async () => { const dbB = as(B); const b = writeBatch(dbB); b.delete(doc(dbB, 'messages', mid, 'msgs', 'm1')); b.delete(doc(dbB, 'matches', mid)); await b.commit(); })()));
await t('rooms: post own room message', assertSucceeds(setDoc(doc(as(A), 'rooms', 'lava', 'messages', 'r1'), { uid: A, text: 'yo' })));
await t('rooms: react (reactions only)', assertSucceeds(updateDoc(doc(as(B), 'rooms', 'lava', 'messages', 'r1'), { reactions: { '🔥': [B] } })));
await t('rooms: cannot edit someone\'s text', assertFails(updateDoc(doc(as(B), 'rooms', 'lava', 'messages', 'r1'), { text: 'edited' })));
await t('presence: write own', assertSucceeds(setDoc(doc(as(A), 'presence', A), { online: true })));
await t('presence: cannot write others', assertFails(setDoc(doc(as(A), 'presence', B), { online: true })));
await t('adminConfig: users read feature flags', assertSucceeds(getDoc(doc(as(A), 'adminConfig', 'featureFlags'))));
await t('adminConfig: users cannot flip flags', assertFails(setDoc(doc(as(A), 'adminConfig', 'featureFlags'), { promoMode: true })));
await t('adminConfig: admin flips flags', assertSucceeds(setDoc(doc(as(ADMIN), 'adminConfig', 'featureFlags'), { promoMode: false }, { merge: true })));

console.log('\n' + results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed` + (failed ? `  —  ${failed} FAILED` : '  —  ALL PASS ✅'));
await env.cleanup();
process.exit(failed ? 1 : 0);
