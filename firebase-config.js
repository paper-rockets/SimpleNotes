// ─── Firebase Auth & Firestore ───────────────────────────────────────────
// SDK v10+ via CDN ESM imports.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// ─── CONFIG ───────────────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey: 'AIzaSyAwwVAj1TDxioROFqu63EJJRth38qRnFVo',
  authDomain: 'paper-rockets-test.firebaseapp.com',
  projectId: 'paper-rockets-test',
  storageBucket: 'paper-rockets-test.firebasestorage.app',
  messagingSenderId: '408806618983',
  appId: '1:408806618983:web:dd0ed2822deecc466ca1c2',
  measurementId: 'G-P0ED2VMF4C',
};

let app, auth, firestore, provider;
let _unsubFirestore = null;

// ─── INIT ────────────────────────────────────────────────────────────────

export function initFirebase() {
  if (!firebaseConfig.apiKey || !firebaseConfig.authDomain || !firebaseConfig.projectId || !firebaseConfig.appId) {
    console.warn('[Firebase] New project configuration is required');
    return false;
  }
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    firestore = getFirestore(app);
    
    provider = new GoogleAuthProvider();
    console.log('[Firebase] Initialized');
    return true;
  } catch (e) {
    console.warn('[Firebase] Init failed — running in local-only mode:', e.message);
    return false;
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────

export async function signInWithGoogle() {
  if (!auth) return null;
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (e) {
    console.error('[Auth] Sign-in failed:', e.message);
    throw e;
  }
}

export async function signOutUser() {
  if (!auth) return;
  if (_unsubFirestore) {
    _unsubFirestore();
    _unsubFirestore = null;
  }
  try {
    await signOut(auth);
  } catch (e) {
    console.error('[Auth] Sign-out failed:', e.message);
  }
}

export function onAuthChange(callback) {
  if (!auth) return;
  onAuthStateChanged(auth, (user) => callback(user || null));
}

// ─── FIRESTORE SYNC ──────────────────────────────────────────────────────

export function listenToFirestore(userId, callback) {
  if (!firestore) return;

  // Unsubscribe previous listener
  if (_unsubFirestore) _unsubFirestore();

  const notesRef = collection(firestore, 'users', userId, 'notes');
  const q = query(notesRef, orderBy('updatedAt', 'desc'));

  _unsubFirestore = onSnapshot(q, (snapshot) => {
    const notes = [];
    snapshot.forEach((docSnap) => {
      notes.push({ id: docSnap.id, ...docSnap.data() });
    });
    callback(notes, snapshot.metadata);
  }, (error) => {
    console.error('[Firestore] Listener error:', error);
    callback(null, { error });
  });
}

export async function syncNoteToFirestore(userId, noteData) {
  if (!firestore) return;
  const noteRef = doc(firestore, 'users', userId, 'notes', noteData.id);

  // Recordings stay in IndexedDB until transcription succeeds.
  const cleanData = { ...noteData };
  delete cleanData.audioBlob;
  delete cleanData._syncTimeout;
  cleanData._serverTimestamp = serverTimestamp();

  await setDoc(noteRef, cleanData);
}

export async function deleteNoteFromFirestore(userId, noteId) {
  if (!firestore) return;
  const noteRef = doc(firestore, 'users', userId, 'notes', noteId);
  await deleteDoc(noteRef);
}

export function stopFirestoreListener() {
  if (_unsubFirestore) {
    _unsubFirestore();
    _unsubFirestore = null;
  }
}
