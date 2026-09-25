// ─── SimpleNotes · Main Application ──────────────────────────────────────
// State management, UI rendering, audio recording, sync orchestration.

// Local drafts are stored in IndexedDB and synced to Firestore.
import {
  initFirebase,
  signInWithGoogle,
  signOutUser,
  onAuthChange,
  stopFirestoreListener,
  listenToFirestore,
  syncNoteToFirestore,
  deleteNoteFromFirestore,
} from './firebase-config.js';
import { transcribeAudio, hasGeminiKey, saveGeminiKey } from './gemini-service.js';
import { loadLocalRecords, saveLocalRecord, removeLocalRecord } from './local-store.js';

// ─── STATE ───────────────────────────────────────────────────────────────

const state = {
  notes: [],
  theme: localStorage.getItem('sn-theme') || 'light',
  user: null,
  recordingState: 'idle', // 'idle' | 'recording' | 'processing'
  syncStatus: 'local',    // 'local' | 'syncing' | 'synced'
  currentAudioBlob: null,
  activeDraftId: null,
  fontSize: parseInt(localStorage.getItem('sn-font-size')) || 16,
  fontFamily: localStorage.getItem('sn-font-family') || 'Inter',
  deletedIds: new Set(),
  authEpoch: 0,
};

// ─── DOM REFS ────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// --- FACTORY -------------------------------------------------------------

export function createNote(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
    title: '',
    content: '',
    isChecklist: false,
    checklistItems: [],
    tags: [],
    audioBlob: null,
    audioUrl: null,
    transcription: '',
    reminder: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─── INIT ────────────────────────────────────────────────────────────────

async function init() {
  applyTheme();
  applyTypography();

  const firebaseOk = initFirebase();

  state.notes = [];

  renderNotes();
  setupEventListeners();

  // Auto-focus for frictionless creation
  $('note-input')?.focus();

  if (firebaseOk) {
    onAuthChange(handleAuthChange);
  } else {
    $('auth-overlay')?.classList.remove('hidden');
    const message = $('auth-overlay')?.querySelector('p');
    if (message) message.textContent = 'Connect a new Firebase project to enable sign-in and sync.';
    const button = $('overlay-auth-btn');
    if (button) button.disabled = true;
  }

  registerServiceWorker();
}

// ─── THEME ───────────────────────────────────────────────────────────────

function applyTheme() {
  document.documentElement.classList.toggle('dark', state.theme === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = state.theme === 'dark' ? '#121212' : '#EAE5D9';
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('sn-theme', state.theme);
  applyTheme();
}

// ─── TYPOGRAPHY ──────────────────────────────────────────────────────────

function applyTypography() {
  document.documentElement.style.setProperty('--base-size', `${state.fontSize}px`);
  document.documentElement.style.setProperty('--font-family', `"${state.fontFamily}"`);
  
  const slider = $('font-size-slider');
  const display = $('font-size-display');
  if (slider) slider.value = state.fontSize;
  if (display) display.textContent = `${state.fontSize}px`;

  document.querySelectorAll('.font-btn').forEach(btn => {
    if (btn.dataset.font === state.fontFamily) {
      btn.classList.add('bg-paper-text', 'text-paper-bg', 'dark:bg-ink-text', 'dark:text-ink-bg');
    } else {
      btn.classList.remove('bg-paper-text', 'text-paper-bg', 'dark:bg-ink-text', 'dark:text-ink-bg');
    }
  });
}

function updateFontSize(e) {
  state.fontSize = e.target.value;
  localStorage.setItem('sn-font-size', state.fontSize);
  applyTypography();
}

function updateFontFamily(font) {
  state.fontFamily = font;
  localStorage.setItem('sn-font-family', state.fontFamily);
  applyTypography();
}

// ─── MENU ─────────────────────────────────────────────────────────────────

function toggleMenu() {
  const modal = $('menu-modal');
  if (!modal) return;
  const isHidden = modal.classList.contains('hidden');
  
  if (isHidden) {
    modal.classList.remove('hidden');
    // slight delay to allow display block to apply before animating transform
    setTimeout(() => {
      modal.querySelector('.modal-card')?.classList.remove('translate-y-full');
    }, 10);
  } else {
    modal.querySelector('.modal-card')?.classList.add('translate-y-full');
    setTimeout(() => {
      modal.classList.add('hidden');
    }, 300); // match transition duration
  }
}

function openGeminiSettings() {
  const modal = $('menu-modal');
  if (modal?.classList.contains('hidden')) toggleMenu();
  setTimeout(() => $('gemini-api-key')?.focus(), 20);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────

async function handleAuthChange(user) {
  const epoch = ++state.authEpoch;
  clearTimeout(_autoSaveTimer);
  for (const timer of Object.values(_editTimers)) clearTimeout(timer);
  for (const id of Object.keys(_editTimers)) delete _editTimers[id];
  stopFirestoreListener();
  state.user = user || null;
  state.notes = [];
  state.deletedIds = new Set();
  state.activeDraftId = null;
  state.currentAudioBlob = null;
  if ($('note-input')) $('note-input').textContent = '';
  hideAudioPreview();
  updateAuthUI();
  
  const overlay = $('auth-overlay');
  if (overlay) {
    if (state.user) overlay.classList.add('hidden');
    else overlay.classList.remove('hidden');
  }

  if (user) {
    try {
      const records = await loadLocalRecords(user.uid);
      if (epoch !== state.authEpoch) return;
      state.deletedIds = new Set(records.filter(r => r.status === 'deleted').map(r => r.note.id));
      state.notes = records.filter(r => r.status !== 'deleted').map(r => ({
        ...r.note,
        _localStatus: r.status,
      }));
      renderNotes();
      scheduleActiveReminders();
      showLegacyRecovery();
      listenToFirestore(user.uid, (notes, metadata) => {
        if (epoch === state.authEpoch && state.user?.uid === user.uid) {
          if (metadata?.error) {
            setSaveStatus('Sync unavailable · check Firestore access');
            return;
          }
          handleFirestoreUpdate(notes, metadata).catch(error => console.error('[Sync] Merge failed:', error));
        }
      });
      for (const record of records) {
        if (record.status === 'deleted') retryDeleteNote(record.note.id, user.uid);
        else if (record.status === 'pending') {
          const note = state.notes.find(n => n.id === record.note.id);
          if (note?.audioBlob && hasGeminiKey()) retryTranscription(note);
          else if (note && !note.audioBlob) saveNoteToCloud(note);
        }
      }
    } catch (e) {
      console.error('[Local] Notes could not be loaded:', e);
      setSaveStatus('Local storage unavailable');
      listenToFirestore(user.uid, (notes, metadata) => {
        if (epoch === state.authEpoch && state.user?.uid === user.uid) {
          if (metadata?.error) {
            setSaveStatus('Sync unavailable · check Firestore access');
            return;
          }
          handleFirestoreUpdate(notes, metadata).catch(error => console.error('[Sync] Merge failed:', error));
        }
      });
    }
  } else {
    renderNotes();
  }
}

function updateAuthUI() {
  const btn = $('auth-btn');
  if (!btn) return;

  if (state.user) {
    if (state.user.photoURL) {
      const avatar = document.createElement('img');
      avatar.src = state.user.photoURL;
      avatar.className = 'w-6 h-6 rounded-full';
      avatar.alt = state.user.displayName || 'Account';
      avatar.referrerPolicy = 'no-referrer';
      btn.replaceChildren(avatar);
    } else {
      btn.textContent = 'OUT';
    }
    btn.title = `Sign out (${state.user.email || ''})`;
  } else {
    btn.textContent = 'SIGN IN';
    btn.title = 'Sign in with Google';
  }
}

async function handleAuth() {
  if (state.user) {
    await signOutUser();
  } else {
    try {
      await signInWithGoogle();
    } catch (error) {
      const message = error?.code === 'auth/unauthorized-domain'
        ? 'This domain is not authorized in Firebase Authentication.'
        : error?.code === 'auth/popup-blocked' || error?.code === 'auth/popup-closed-by-user'
          ? 'Google sign-in popup was closed or blocked. Try a regular browser.'
          : 'Google sign-in failed. Check the Firebase project settings.';
      setSaveStatus(message);
      const overlayMessage = $('auth-overlay')?.querySelector('p');
      if (overlayMessage) overlayMessage.textContent = message;
    }
  }
}

// ─── SYNC ────────────────────────────────────────────────────────────────

const cloudOperations = new Map();
const transcribingIds = new Set();

function setSaveStatus(message) {
  const status = $('save-status');
  if (status) status.textContent = message;
}

function showLegacyRecovery() {
  const recovery = $('legacy-recovery');
  if (!recovery) return;
  try {
    const oldQueue = JSON.parse(localStorage.getItem('unsyncedNotes') || '[]');
    recovery.classList.toggle('hidden', !Array.isArray(oldQueue) || !oldQueue.length);
  } catch (_) {
    recovery.classList.add('hidden');
  }
}

async function importLegacyNotes() {
  if (!state.user) return;
  let oldQueue;
  try { oldQueue = JSON.parse(localStorage.getItem('unsyncedNotes') || '[]'); }
  catch (_) { return; }
  if (!Array.isArray(oldQueue)) return;
  for (const old of oldQueue) {
    if (!old?.title && !old?.content && !old?.audioUrl) continue;
    const note = createNote({
      title: String(old.title || ''),
      content: escapeHtml(stripHtml(old.content || '')),
      audioUrl: typeof old.audioUrl === 'string' ? old.audioUrl : null,
    });
    state.notes.unshift(note);
    await saveNoteToCloud(note);
  }
  localStorage.removeItem('unsyncedNotes');
  showLegacyRecovery();
  renderNotes();
}

function queueCloudOperation(noteId, operation) {
  const previous = cloudOperations.get(noteId) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  cloudOperations.set(noteId, next);
  next.then(() => {
    if (cloudOperations.get(noteId) === next) cloudOperations.delete(noteId);
  }, () => {
    if (cloudOperations.get(noteId) === next) cloudOperations.delete(noteId);
  });
  return next;
}

async function persistPendingNote(note) {
  if (!state.user || !note) return;
  note._localRevision = (note._localRevision || 0) + 1;
  note._localStatus = 'pending';
  try {
    await saveLocalRecord(state.user.uid, note, 'pending');
    setSaveStatus(navigator.onLine ? 'Saving…' : 'Saved on this device · offline');
  } catch (e) {
    console.error('[Local] Save failed:', e);
    setSaveStatus('Could not save on this device');
    throw e;
  }
}

async function saveNoteToCloud(note) {
  if (!state.user || !note || !state.notes.includes(note) || state.deletedIds.has(note.id)) return;
  const userId = state.user.uid;
  try {
    try { await persistPendingNote(note); }
    catch (_) { if (!navigator.onLine) return; }
    // A recording stays on the device until it has been converted to text.
    if (note.audioBlob) return;
    await queueCloudOperation(note.id, async () => {
      if (state.deletedIds.has(note.id) || state.user?.uid !== userId) return;
      const current = state.notes.find(n => n.id === note.id);
      if (!current) return;
      const { audioBlob, audioUrl, _localStatus, _localRevision, _syncTimeout, ...data } = current;
      const revision = current._localRevision;
      await syncNoteToFirestore(userId, data);
      if (current._localRevision === revision && !state.deletedIds.has(note.id)) {
        current._localStatus = 'synced';
        await saveLocalRecord(userId, current, 'synced');
        setSaveStatus('Saved');
      }
    });
  } catch (e) {
    console.error('[Sync] Save failed:', e);
    setSaveStatus('Saved on this device · waiting to sync');
  }
}

async function handleFirestoreUpdate(remoteNotes, metadata = {}) {
  const userId = state.user?.uid;
  if (!userId) return;
  const editingElement = document.activeElement?.closest?.('.note-content[contenteditable="true"]');
  const editingId = editingElement?.closest?.('[data-note-id]')?.dataset.noteId;
  // Merge remote notes without blowing away local edits
  for (const remote of remoteNotes) {
    if (state.deletedIds.has(remote.id)) continue;
    const local = state.notes.find((n) => n.id === remote.id);
    if (!local) {
      const hydrated = { ...remote, _localStatus: 'synced' };
      state.notes.push(hydrated);
      await saveLocalRecord(userId, hydrated, 'synced');
      if (hydrated.reminder && !hydrated.reminder.notified) scheduleReminder(hydrated);
    } else if (local._localStatus !== 'pending' && local.id !== editingId) {
      Object.assign(local, remote, { _localStatus: 'synced' });
      await saveLocalRecord(userId, local, 'synced');
      if (local.reminder && !local.reminder.notified) scheduleReminder(local);
    }
  }
  
  // A cached/empty snapshot is not proof that a local note was deleted remotely.
  if (!metadata.fromCache) {
    const remoteIds = new Set(remoteNotes.map(note => note.id));
    const removed = state.notes.filter(n => !remoteIds.has(n.id) && n._localStatus === 'synced' && n.id !== editingId);
    state.notes = state.notes.filter(n => remoteIds.has(n.id) || n._localStatus === 'pending' || n.id === editingId);
    for (const note of removed) await removeLocalRecord(userId, note.id);
  }
  
  // Sort by creation time (descending) so note order never changes on edit/click
  state.notes.sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return timeB - timeA;
  });
  
  if (editingElement) {
    editingElement.addEventListener('blur', renderNotes, { once: true });
  } else {
    renderNotes();
  }
}



// ─── NOTE CRUD ───────────────────────────────────────────────────────────

// ─── AUTO-SAVE DRAFT ─────────────────────────────────────────────────────

let _autoSaveTimer = null;

function autoSaveDraftNote() {
  const bodyEl = $('note-input');
  if (!bodyEl) return;

  const rawHTML = bodyEl.innerHTML.trim();
  const textContent = bodyEl.textContent.trim();

  const hasData = textContent || state.currentAudioBlob;

  if (!hasData) {
    if (state.activeDraftId) {
      handleDeleteNote(state.activeDraftId);
      state.activeDraftId = null;
    }
    return;
  }

  const parsed = parseMergedContent(rawHTML);
  const tags = extractTags(parsed.title + ' ' + textContent);

  if (!state.activeDraftId) {
    const note = createNote({
      title: parsed.title,
      content: parsed.content,
      tags,
      audioBlob: state.currentAudioBlob || null,
    });
    state.activeDraftId = note.id;
    state.notes.unshift(note);
    renderNotes();
  } else {
    const note = state.notes.find((n) => n.id === state.activeDraftId);
    if (note) {
      note.title = parsed.title;
      note.content = parsed.content;
      note.tags = tags;
      note.audioBlob = state.currentAudioBlob || null;
      note.updatedAt = new Date().toISOString();
      note.synced = false;
      updateCardDOM(note);
    }
  }

  // Guarantee offline persistence before debounce
  if (state.activeDraftId) {
    const note = state.notes.find(n => n.id === state.activeDraftId);
    if (note) persistPendingNote(note).catch(() => {});
  }

  // Debounce DB & Cloud sync
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    if (!state.activeDraftId) return;
    const note = state.notes.find((n) => n.id === state.activeDraftId);
    if (note) {
      await saveNoteToCloud(note);
    }
  }, 400);
}

function updateCardDOM(note) {
  const card = document.querySelector(`[data-note-id="${note.id}"]`);
  if (!card) {
    renderNotes();
    return;
  }
  const contentEl = card.querySelector('.note-content');
  if (contentEl && contentEl !== document.activeElement && !note.isChecklist) {
    const titlePart = note.title ? `<div class="font-bold mb-1">${autolink(note.title)}</div>` : '';
    const bodyPart = note.content ? renderSafeContent(note.content) : '';
    contentEl.innerHTML = titlePart + bodyPart;
  }
}

async function handleDeleteNote(noteId) {
  const deletedNote = state.notes.find((n) => n.id === noteId);
  clearTimeout(_editTimers[noteId]);
  if (state.activeDraftId === noteId) {
    clearTimeout(_autoSaveTimer);
    state.activeDraftId = null;
  }

  
  state.notes = state.notes.filter((n) => n.id !== noteId);
  state.deletedIds.add(noteId);
  renderNotes();
  if (state.user) {
    const userId = state.user.uid;
    try {
      await saveLocalRecord(userId, { id: noteId }, 'deleted');
      setSaveStatus(navigator.onLine ? 'Deleting…' : 'Delete queued · offline');
      retryDeleteNote(noteId, userId);
    } catch (e) {
      console.error('[Delete] Could not queue deletion:', e);
      state.deletedIds.delete(noteId);
      if (deletedNote) state.notes.push(deletedNote);
      renderNotes();
      setSaveStatus('Delete could not be saved');
    }
  }
}

async function retryDeleteNote(noteId, userId) {
  try {
    await queueCloudOperation(noteId, async () => {
      await deleteNoteFromFirestore(userId, noteId);
      await removeLocalRecord(userId, noteId);
      if (state.user?.uid === userId) state.deletedIds.delete(noteId);
      setSaveStatus('Saved');
    });
  } catch (e) {
    console.error('[Delete] Waiting to sync:', e);
    setSaveStatus('Delete queued · waiting to sync');
  }
}

// Debounce map for inline edits
const _editTimers = {};

function handleNoteEdit(noteId, updates) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;

  // Check if anything actually changed to prevent sorting/syncing on simple click/blur
  let changed = false;
  for (const key in updates) {
    const val1 = note[key] === undefined || note[key] === null ? '' : String(note[key]).trim();
    const val2 = updates[key] === undefined || updates[key] === null ? '' : String(updates[key]).trim();
    if (val1 !== val2) {
      changed = true;
      break;
    }
  }
  if (!changed) return;

  Object.assign(note, updates);
  note.synced = false;
  note.updatedAt = new Date().toISOString();

  note.tags = extractTags(
    (note.title || '') + ' ' + (note.content || '').replace(/<[^>]*>/g, '')
  );
  persistPendingNote(note).catch(() => {});

  // Debounce DB write / Cloud sync
  clearTimeout(_editTimers[noteId]);
  _editTimers[noteId] = setTimeout(async () => {
    await saveNoteToCloud(note);
  }, 800);
}

function extractTags(text) {
  const matches = text.match(/#[a-zA-Z]\w*/g);
  return matches ? [...new Set(matches.map((t) => t.toLowerCase()))] : [];
}

// ─── AUDIO RECORDING ────────────────────────────────────────────────────

let mediaRecorder = null;
let audioChunks = [];

async function toggleRecording() {
  if (state.recordingState === 'idle') {
    // Finish any text draft before opening a fresh voice note.
    if (state.activeDraftId) handleSave();
    state.activeDraftId = null;
    const bodyEl = $('note-input');
    if (bodyEl) bodyEl.innerHTML = '';
    state.currentAudioBlob = null;
    hideAudioPreview();
    await startRecording();
  } else if (state.recordingState === 'recording') {
    stopRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Pick best supported mime type
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';

    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || mimeType });
      stream.getTracks().forEach((t) => t.stop());
      await processRecording(blob);
    };

    mediaRecorder.start(250);
    state.recordingState = 'recording';
    updateRecordingUI();
  } catch (e) {
    console.error('[Mic] Access denied:', e);
    setSaveStatus('Microphone unavailable · check browser permission');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    state.recordingState = 'processing';
    updateRecordingUI();
  }
}

async function processRecording(blob) {
  const bodyEl = $('note-input');
  if (!blob.size || !bodyEl) {
    state.recordingState = 'idle';
    updateRecordingUI();
    return;
  }
  state.currentAudioBlob = blob;
  showAudioPreview(blob);
  autoSaveDraftNote();
  const note = state.notes.find(n => n.id === state.activeDraftId);
  if (note) {
    try { await persistPendingNote(note); } catch (e) { /* Still attempt conversion. */ }
    if (hasGeminiKey()) await retryTranscription(note, true);
    else setSaveStatus('Voice saved here · add Gemini key in Settings to transcribe');
  }
  state.recordingState = 'idle';
  updateRecordingUI();
}

async function retryTranscription(note, inEditor = false) {
  if (!note?.audioBlob || transcribingIds.has(note.id)) return;
  if (!hasGeminiKey()) {
    setSaveStatus('Voice saved here · add Gemini key in Settings to transcribe');
    openGeminiSettings();
    return;
  }
  const userId = state.user?.uid;
  transcribingIds.add(note.id);
  setSaveStatus('Converting voice to text…');
  try {
    const transcription = await transcribeAudio(note.audioBlob);
    if (!transcription) throw new Error('No speech was detected');
    if (state.user?.uid !== userId || state.deletedIds.has(note.id)) return;
    const safeText = escapeHtml(transcription).replace(/\r?\n/g, '<br>');
    const originalAudio = note.audioBlob;
    const previousContent = note.content;
    if (inEditor && state.activeDraftId === note.id) {
      const editor = $('note-input');
      const nextHtml = editor.innerHTML.trim()
        ? `${editor.innerHTML}<br><br>${safeText}` : safeText;
      const parsed = parseMergedContent(nextHtml);
      const previousTitle = note.title;
      const previousTags = note.tags;
      note.title = parsed.title;
      note.content = parsed.content;
      note.tags = extractTags(parsed.title + ' ' + editor.textContent + ' ' + transcription);
      note.audioBlob = null;
      try {
        await persistPendingNote(note);
      } catch (e) {
        note.title = previousTitle;
        note.content = previousContent;
        note.tags = previousTags;
        note.audioBlob = originalAudio;
        throw e;
      }
      editor.innerHTML = nextHtml;
      state.currentAudioBlob = null;
      hideAudioPreview();
      updateCardDOM(note);
    } else {
      note.content = note.content ? `${note.content}<br><br>${safeText}` : safeText;
      note.audioBlob = null;
      note.audioUrl = null;
      note.updatedAt = new Date().toISOString();
      try {
        await persistPendingNote(note);
      } catch (e) {
        note.content = previousContent;
        note.audioBlob = originalAudio;
        throw e;
      }
      renderNotes();
    }
    await saveNoteToCloud(note);
  } catch (e) {
    console.error('[Transcription] Failed:', e);
    setSaveStatus(hasGeminiKey()
      ? 'Voice saved on this device · tap Retry'
      : 'Voice saved on this device · add Gemini key in Settings');
    if (!inEditor) renderNotes();
  } finally {
    transcribingIds.delete(note.id);
  }
}

function createMinimalAudioPlayer(src) {
  const player = document.createElement('div');
  player.className =
    'flex items-center gap-2.5 py-1 px-0 w-fit select-none text-[10px] md:text-xs font-bold tracking-widest uppercase text-paper-dim dark:text-ink-dim hover:text-paper-text dark:hover:text-ink-text transition-colors my-1.5';

  const audio = new Audio(src);

  // Play / Pause button
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className =
    'text-paper-text dark:text-ink-text hover:opacity-70 focus:outline-none flex items-center justify-center w-3.5 h-3.5 shrink-0';
  playBtn.innerHTML = `▶`;

  // Thin 2px progress bar container
  const progressTrack = document.createElement('div');
  progressTrack.className =
    'w-20 md:w-28 h-[2px] bg-paper-border dark:bg-ink-border rounded-full cursor-pointer relative overflow-hidden shrink-0';

  const progressBar = document.createElement('div');
  progressBar.className =
    'h-full bg-paper-text dark:bg-ink-text rounded-full transition-all duration-75 w-0';
  progressTrack.appendChild(progressBar);

  // Time display label
  const timeLabel = document.createElement('span');
  timeLabel.className = 'tabular-nums text-[10px] shrink-0';
  timeLabel.textContent = '0:00';

  function formatSecs(sec) {
    if (!sec || !isFinite(sec) || isNaN(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function updateProgress() {
    const dur = audio.duration;
    const cur = audio.currentTime;
    if (dur && isFinite(dur) && !isNaN(dur)) {
      const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
      progressBar.style.width = `${pct}%`;
      timeLabel.textContent = `${formatSecs(cur)} / ${formatSecs(dur)}`;
    } else {
      timeLabel.textContent = formatSecs(cur);
    }
  }

  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration === Infinity || isNaN(audio.duration)) {
      // Chrome WebM duration workaround
      audio.currentTime = 1e101;
      audio.ontimeupdate = function () {
        this.ontimeupdate = () => updateProgress();
        audio.currentTime = 0;
      };
    } else {
      updateProgress();
    }
  });
  
  audio.addEventListener('durationchange', updateProgress);
  audio.addEventListener('timeupdate', updateProgress);

  audio.addEventListener('ended', () => {
    playBtn.textContent = '▶';
    progressBar.style.width = '0%';
    updateProgress();
  });

  playBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (audio.paused) {
      document.querySelectorAll('audio').forEach((a) => a.pause());
      audio.play();
      playBtn.textContent = '❚❚';
    } else {
      audio.pause();
      playBtn.textContent = '▶';
    }
  };

  // Click on thin bar to seek
  progressTrack.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = progressTrack.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    if (audio.duration && isFinite(audio.duration)) {
      audio.currentTime = Math.min(audio.duration, Math.max(0, pos * audio.duration));
      updateProgress();
    }
  };

  player.appendChild(playBtn);
  player.appendChild(progressTrack);
  player.appendChild(timeLabel);
  return player;
}

function showAudioPreview(blob) {
  const container = $('audio-preview');
  if (!container) return;
  hideAudioPreview();
  container.innerHTML = '';
  const url = URL.createObjectURL(blob);
  previewAudioUrl = url;
  const player = createMinimalAudioPlayer(url);
  container.appendChild(player);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'min-h-11 text-xs underline underline-offset-4 text-paper-dim dark:text-ink-dim';
  retry.textContent = hasGeminiKey() ? 'Retry transcription' : 'Add Gemini key to transcribe';
  retry.addEventListener('click', () => {
    if (!hasGeminiKey()) {
      openGeminiSettings();
      return;
    }
    const note = state.notes.find(n => n.id === state.activeDraftId);
    if (note) retryTranscription(note, true);
  });
  container.appendChild(retry);
  container.classList.remove('hidden');
}

function hideAudioPreview() {
  if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl);
  previewAudioUrl = null;
  const container = $('audio-preview');
  if (container) {
    container.innerHTML = '';
    container.classList.add('hidden');
  }
}

function updateRecordingUI() {
  const dot = $('mic-dot');
  const text = $('mic-text');
  if (!dot || !text) return;

  switch (state.recordingState) {
    case 'recording':
      text.textContent = 'STOP';
      dot.className = 'w-1.5 h-1.5 md:w-2 md:h-2 rounded-full bg-red-500 recording-pulse';
      break;
    case 'processing':
      text.textContent = 'AI...';
      dot.className = 'w-1.5 h-1.5 md:w-2 md:h-2 rounded-full bg-paper-dim dark:bg-ink-dim animate-pulse';
      break;
    default:
      text.textContent = 'REC';
      dot.className = 'w-1.5 h-1.5 md:w-2 md:h-2 rounded-full bg-paper-text dark:bg-ink-text';
  }
}

// ─── LIST ↔ TEXT TOGGLE ──────────────────────────────────────────────────

function toggleChecklist(noteId, btn) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;

  const card = document.querySelector(`[data-note-id="${noteId}"]`);
  if (!card) return;
  const content = card.querySelector('.note-content');

  if (!note.isChecklist) {
    // → Checklist
    const lines = content.innerText.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return;

    note.isChecklist = true;
    note.checklistItems = lines.map((t) => ({
      text: t.trim(),
      checked: false,
    }));

    renderChecklistDOM(content, note);
    btn.textContent = 'TEXT';
  } else {
    // → Text
    const text = (note.checklistItems || []).map((i) => i.text);
    note.isChecklist = false;
    note.content = text
      .map((line, i) => (i === 0 ? escapeHtml(line) : `<div>${escapeHtml(line)}</div>`))
      .join('');

    content.innerHTML = renderSafeContent(note.content);
    content.setAttribute('contenteditable', 'true');
    content.classList.add('cursor-text');
    btn.textContent = 'LIST';
  }

  note.synced = false;
  note.updatedAt = new Date().toISOString();
  saveNoteToCloud(note);
  
}

function renderChecklistDOM(container, note) {
  container.removeAttribute('contenteditable');
  container.classList.remove('cursor-text');

  let html = '<div class="flex flex-col gap-2 mt-1">';
  (note.checklistItems || []).forEach((item, idx) => {
    const struck = item.checked
      ? 'line-through text-paper-dim dark:text-ink-dim'
      : '';
    html += `
      <label class="flex items-start gap-3 cursor-pointer select-none">
        <input type="checkbox" ${item.checked ? 'checked' : ''}
          data-idx="${idx}"
          class="sn-checkbox mt-1.5 w-4 h-4 shrink-0 cursor-pointer">
        <span class="${struck} outline-none w-full cursor-text transition-all duration-200"
          contenteditable="true">${autolink(item.text)}</span>
      </label>`;
  });
  html += '</div>';
  container.innerHTML = html;

  // Wire checkbox toggles
  container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.idx, 10);
      note.checklistItems[idx].checked = cb.checked;
      const span = cb.closest('label').querySelector('span');
      span.classList.toggle('line-through', cb.checked);
      span.classList.toggle('text-paper-dim', cb.checked);
      span.classList.toggle('dark:text-ink-dim', cb.checked);
      note.synced = false;
      note.updatedAt = new Date().toISOString();
      saveNoteToCloud(note);
    });
  });

  // Wire span edits
  container.querySelectorAll('span[contenteditable]').forEach((span, idx) => {
    span.addEventListener('paste', pastePlainText);
    span.addEventListener('blur', () => {
      note.checklistItems[idx].text = span.textContent;
      note.synced = false;
      note.updatedAt = new Date().toISOString();
      saveNoteToCloud(note);
    });
  });
}

// ─── REMINDERS ───────────────────────────────────────────────────────────

let _currentReminderNoteId = null;
const _reminderTimers = {};

function showReminderModal(noteId) {
  _currentReminderNoteId = noteId;
  const note = state.notes.find((n) => n.id === noteId);
  const input = $('reminder-datetime');
  const modal = $('reminder-modal');
  if (!input || !modal) return;

  if (note?.reminder?.datetime) {
    const date = new Date(note.reminder.datetime);
    input.value = localDateTimeValue(date);
  } else {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    input.value = localDateTimeValue(d);
  }

  modal.classList.remove('hidden');
  modal.querySelector('.modal-card')?.classList.add('modal-enter');
}

function hideReminderModal() {
  const modal = $('reminder-modal');
  if (modal) modal.classList.add('hidden');
  _currentReminderNoteId = null;
}

async function saveReminder() {
  if (!_currentReminderNoteId) return;
  const note = state.notes.find((n) => n.id === _currentReminderNoteId);
  if (!note) return;

  const val = $('reminder-datetime')?.value;
  if (!val) return;

  // Request notification permission if needed
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  note.reminder = { datetime: new Date(val).toISOString(), notified: false };
  note.synced = false;
  note.updatedAt = new Date().toISOString();
  await saveNoteToCloud(note);

  scheduleReminder(note);
  renderNotes();
  hideReminderModal();
  
}

async function clearReminder() {
  if (!_currentReminderNoteId) return;
  const note = state.notes.find((n) => n.id === _currentReminderNoteId);
  if (!note) return;

  note.reminder = null;
  note.synced = false;
  note.updatedAt = new Date().toISOString();
  await saveNoteToCloud(note);

  clearTimeout(_reminderTimers[note.id]);
  renderNotes();
  hideReminderModal();
  
}

function scheduleActiveReminders() {
  state.notes.forEach((note) => {
    if (note.reminder && !note.reminder.notified) {
      scheduleReminder(note);
    }
  });
}

function scheduleReminder(note) {
  if (!note.reminder || note.reminder.notified) return;

  clearTimeout(_reminderTimers[note.id]);

  const delay = new Date(note.reminder.datetime).getTime() - Date.now();

  if (delay <= 0) {
    triggerNotification(note);
    return;
  }

  // Cap setTimeout at ~24 days (max 32-bit int ms)
  const safeDelay = Math.min(delay, 2_147_483_647);
  _reminderTimers[note.id] = setTimeout(() => {
    if (delay > safeDelay) scheduleReminder(note);
    else triggerNotification(note);
  }, safeDelay);
}

function localDateTimeValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function triggerNotification(note) {
  if (note.reminder?.notified) return;

  note.reminder.notified = true;
  await saveNoteToCloud(note);

  const body = note.title || stripHtml(note.content).slice(0, 120) || 'Reminder';

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('SimpleNotes', { body, icon: 'icon.svg', tag: note.id });
  }

  // Update card in DOM
  renderNotes();
}

function generateCalendarUrl(note) {
  if (!note.reminder) return '#';

  const dt = new Date(note.reminder.datetime);
  const fmt = (d) =>
    d
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  const start = fmt(dt);
  const end = fmt(new Date(dt.getTime() + 30 * 60_000));

  const title = encodeURIComponent(note.title || 'SimpleNotes Reminder');
  const details = encodeURIComponent(stripHtml(note.content).slice(0, 200));

  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${start}/${end}&details=${details}`;
}

// ─── RENDERING ───────────────────────────────────────────────────────────
const noteAudioUrls = new Set();
let previewAudioUrl = null;

function renderNotes() {
  const list = $('notes-list');
  if (!list) return;

  for (const url of noteAudioUrls) URL.revokeObjectURL(url);
  noteAudioUrls.clear();
  list.innerHTML = '';

  if (state.notes.length === 0) {
    list.innerHTML = `
      <div class="text-center py-20">
        <p class="text-[10px] font-bold tracking-[0.3em] uppercase text-paper-dim dark:text-ink-dim">
          No notes yet — start typing or record
        </p>
      </div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  state.notes.forEach((note) => {
    if (note.id !== state.activeDraftId) {
      frag.appendChild(buildNoteCard(note));
    }
  });
  list.appendChild(frag);
}

function buildNoteCard(note) {
  const card = document.createElement('div');
  card.className = 'group flex flex-col gap-1 border-b border-solid border-paper-border dark:border-ink-border pb-3 mb-3';
  card.dataset.noteId = note.id;

  // ── Content (merged title and content)
  const contentEl = document.createElement('div');
  contentEl.className =
    'note-content text-lg md:text-xl font-medium leading-normal outline-none break-words [overflow-wrap:anywhere]';

  let isTruncated = false;

  if (note.isChecklist) {
    renderChecklistDOM(contentEl, note);
  } else {
    contentEl.contentEditable = 'true';
    contentEl.addEventListener('paste', pastePlainText);
    contentEl.classList.add('cursor-text');
    const titlePart = note.title ? `<div class="font-bold mb-1">${autolink(note.title)}</div>` : '';
    const bodyPart = note.content ? renderSafeContent(note.content) : '';
    contentEl.innerHTML = titlePart + bodyPart;
    contentEl.addEventListener('blur', () => {
      const parsed = parseMergedContent(contentEl.innerHTML);
      handleNoteEdit(note.id, parsed);
    });

    // Limit text displayed to 3 lines
    const rawText = contentEl.textContent || '';
    const rawLines = rawText.split('\n').filter((l) => l.trim());
    if (rawLines.length > 3 || rawText.length > 150) {
      contentEl.classList.add('line-clamp-3');
      isTruncated = true;
    }

    // Auto un-clamp when focused for editing
    contentEl.addEventListener('focus', () => {
      contentEl.classList.remove('line-clamp-3');
    });
  }
  card.appendChild(contentEl);

  // ── Audio player
  if (note.audioBlob || note.audioUrl) {
    let src = '';
    let blobRef = null;
    if (note.audioBlob) {
      blobRef = note.audioBlob instanceof Blob ? note.audioBlob : new Blob([note.audioBlob], { type: 'audio/webm' });
      src = URL.createObjectURL(blobRef);
      noteAudioUrls.add(src);
    } else if (note.audioUrl) {
      src = note.audioUrl;
    }
    if (src) {
      const player = createMinimalAudioPlayer(src);
      
      const aiBtn = document.createElement('button');
       aiBtn.className = 'ml-4 min-h-11 text-xs underline underline-offset-4 text-paper-dim hover:text-paper-text dark:text-ink-dim dark:hover:text-ink-text transition-colors shrink-0';
       aiBtn.title = 'Convert voice to text with Gemini';
       aiBtn.textContent = !hasGeminiKey() ? 'Add Gemini key to transcribe'
         : note.audioBlob ? 'Retry transcription' : 'Convert to text';
      
       aiBtn.setAttribute('aria-label', aiBtn.textContent);
       aiBtn.onclick = async (e) => {
         e.preventDefault();
         e.stopPropagation();
         if (!hasGeminiKey()) {
           openGeminiSettings();
           return;
         }
         aiBtn.classList.add('animate-pulse');
         try {
           if (!blobRef && note.audioUrl) {
             const response = await fetch(note.audioUrl);
             if (!response.ok) throw new Error('Could not load recording');
             blobRef = await response.blob();
             note.audioBlob = blobRef;
             await persistPendingNote(note);
           }
           await retryTranscription(note);
         } catch (err) {
           console.error(err);
           setSaveStatus('Could not load voice note · try again');
         } finally {
           aiBtn.classList.remove('animate-pulse');
         }
      };
      
      player.appendChild(aiBtn);
      card.appendChild(player);
    }
  }

  // ── Tags
  if (note.tags?.length > 0) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'flex gap-2 flex-wrap mt-1';
    note.tags.forEach((tag) => {
      const badge = document.createElement('span');
      badge.className =
        'text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 border border-paper-border dark:border-ink-border text-paper-dim dark:text-ink-dim';
      badge.textContent = tag;
      tagsEl.appendChild(badge);
    });
    card.appendChild(tagsEl);
  }

  // ── Reminder
  if (note.reminder) {
    const remEl = document.createElement('div');
    remEl.className =
      'text-[10px] font-bold tracking-[0.15em] uppercase text-paper-dim dark:text-ink-dim flex items-center gap-3 mt-1';

    const dt = new Date(note.reminder.datetime);
    const dateStr = dt.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const timeStr = dt.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

    remEl.innerHTML = `
      <span class="flex items-center gap-1.5">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        ${dateStr} ${timeStr}
      </span>
      <a href="${generateCalendarUrl(note)}" target="_blank" rel="noopener"
         class="underline underline-offset-2 hover:text-paper-text dark:hover:text-ink-text transition-colors">
        + GCAL
      </a>
      ${note.reminder.notified ? '<span class="opacity-50">DONE</span>' : ''}
    `;
    card.appendChild(remEl);
  }

  // ── Actions (visible on hover / focus-within)
  const actions = document.createElement('div');
  actions.className =
    'flex flex-wrap items-center justify-end gap-x-4 text-xs font-bold tracking-widest uppercase text-paper-dim dark:text-ink-dim opacity-100 md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 mt-1';

  const mkBtn = (label, handler) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className =
      'min-h-11 hover:text-paper-text dark:hover:text-ink-text transition-colors';
    b.addEventListener('click', handler);
    return b;
  };

  const listBtn = mkBtn(note.isChecklist ? 'TEXT' : 'LIST', () =>
    toggleChecklist(note.id, listBtn)
  );
  actions.appendChild(listBtn);

  if (isTruncated) {
    const expandBtn = mkBtn('MORE', () => {
      if (contentEl.classList.contains('line-clamp-3')) {
        contentEl.classList.remove('line-clamp-3');
        expandBtn.textContent = 'LESS';
      } else {
        contentEl.classList.add('line-clamp-3');
        expandBtn.textContent = 'MORE';
      }
    });
    actions.appendChild(expandBtn);
  }

  actions.appendChild(
    mkBtn('REMIND', () => {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      showReminderModal(note.id);
    })
  );
  actions.appendChild(mkBtn('DELETE', () => handleDeleteNote(note.id)));
  card.appendChild(actions);

  return card;
}



// ─── EVENT LISTENERS ─────────────────────────────────────────────────────

function setupEventListeners() {
  $('mic-btn')?.addEventListener('click', toggleRecording);
  $('legacy-import')?.addEventListener('click', importLegacyNotes);
  $('manual-save-btn')?.addEventListener('click', handleSave);
  $('theme-toggle')?.addEventListener('click', toggleTheme);
  $('auth-btn')?.addEventListener('click', handleAuth);

  // Prevent pull-to-refresh on mobile Safari/PWA
  document.body.addEventListener('touchmove', (e) => {
    if (window.scrollY === 0 && e.touches[0].clientY > 0) {
      e.preventDefault();
    }
  }, { passive: false });

  // Flush any pending saves if the user closes the app or switches tabs
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (state.activeDraftId) {
        const note = state.notes.find(n => n.id === state.activeDraftId);
        if (note) saveNoteToCloud(note);
      }
      Object.keys(_editTimers).forEach(id => {
        clearTimeout(_editTimers[id]);
        const note = state.notes.find(n => n.id === id);
        if (note) saveNoteToCloud(note);
      });
    }
  });

  // Auto-save as user types
  $('note-input')?.addEventListener('input', autoSaveDraftNote);
  $('note-input')?.addEventListener('paste', pastePlainText);

  // Ctrl+Enter to save from creation bar
  $('note-input')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  });

  // Save when clicking outside the creation area
  document.addEventListener('click', (e) => {
    const isCreation = e.target.closest('#note-input') || 
                       e.target.closest('#audio-preview') || 
                       e.target.closest('#mic-btn');
    if (!isCreation && state.activeDraftId) {
      const content = $('note-input')?.textContent.trim();
      if (content || state.currentAudioBlob) {
        handleSave();
      }
    }
  });



  // Menu & Settings
  const keyStatus = $('gemini-key-status');
  if (keyStatus && hasGeminiKey()) keyStatus.textContent = 'Key saved on this device. Enter a new key to replace it.';
  $('gemini-key-save')?.addEventListener('click', () => {
    const input = $('gemini-api-key');
    const key = input?.value.trim();
    if (!key) {
      if (keyStatus) keyStatus.textContent = 'Enter a key to save it.';
      return;
    }
    saveGeminiKey(key);
    input.value = '';
    if (keyStatus) keyStatus.textContent = 'Key saved on this device. Enter a new key to replace it.';
    renderNotes();
    for (const note of state.notes) {
      if (note.audioBlob) retryTranscription(note, note.id === state.activeDraftId);
    }
  });
  $('menu-toggle-btn')?.addEventListener('click', toggleMenu);
  $('menu-close-btn')?.addEventListener('click', toggleMenu);
  $('menu-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'menu-modal') toggleMenu();
  });

  $('font-size-slider')?.addEventListener('input', updateFontSize);
  
  document.querySelectorAll('.font-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      updateFontFamily(e.target.dataset.font);
    });
  });

  // Reminder modal
  $('reminder-save')?.addEventListener('click', saveReminder);
  $('reminder-clear')?.addEventListener('click', clearReminder);
  $('reminder-cancel')?.addEventListener('click', hideReminderModal);
  $('reminder-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'reminder-modal') hideReminderModal();
  });

  // Online / offline
  window.addEventListener('online', () => {
    for (const note of state.notes) {
      if (note._localStatus === 'pending') {
        if (note.audioBlob && hasGeminiKey()) retryTranscription(note, note.id === state.activeDraftId);
        else saveNoteToCloud(note);
      }
    }
    if (state.user) for (const id of state.deletedIds) retryDeleteNote(id, state.user.uid);
  });
  window.addEventListener('offline', () => {
    setSaveStatus('Offline · notes will sync when connected');
  });
}

function handleSave() {
  if (state.activeDraftId) {
    const note = state.notes.find(n => n.id === state.activeDraftId);
    if (note) {
      saveNoteToCloud(note);
    }
    state.activeDraftId = null;
    const bodyEl = $('note-input');
    if (bodyEl) bodyEl.innerHTML = '';
    hideAudioPreview();
    state.currentAudioBlob = null;
    renderNotes();
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────

function parseMergedContent(html) {
  let text = html || '';
  
  // Convert block element tags and <br> into newlines for parsing stability
  text = text.replace(/<div[^>]*>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<p[^>]*>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  
  const cleanText = new DOMParser().parseFromString(text, 'text/html').body.textContent || '';
  
  const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const title = lines[0] || '';
  const restLines = lines.slice(1);
  const content = restLines.map((line, idx) => idx === 0 ? escapeHtml(line) : `<div>${escapeHtml(line)}</div>`).join('');
  
  return { title, content };
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function renderSafeContent(html) {
  const blockText = String(html || '')
    .replace(/<\/?(?:div|p)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const text = new DOMParser().parseFromString(blockText, 'text/html').body.textContent || '';
  return text.split('\n').map(autolink).join('<br>');
}

function pastePlainText(event) {
  const text = event.clipboardData?.getData('text/plain');
  if (text == null) return;
  event.preventDefault();
  if (document.execCommand('insertText', false, text)) return;
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  event.target.dispatchEvent(new Event('input', { bubbles: true }));
}

function autolink(text) {
  const source = String(text || '');
  const holder = document.createElement('span');
  const urlRegex = /((?:https?:\/\/|www\.)[^\s<]+|(?:[a-zA-Z0-9-]+\.)+(?:com|io|org|net|edu|gov|app|dev|me|co|uk|de|ca|site|online|xyz|page)(?:\/[^\s<]*)?)/gi;
  let cursor = 0;
  for (const match of source.matchAll(urlRegex)) {
    holder.append(document.createTextNode(source.slice(cursor, match.index)));
    let label = match[0];
    const trailing = /[.,;)]$/.test(label) ? label.slice(-1) : '';
    if (trailing) label = label.slice(0, -1);
    const link = document.createElement('a');
    link.href = /^https?:\/\//i.test(label) ? label : `https://${label}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'underline underline-offset-2';
    link.textContent = label;
    holder.append(link);
    if (trailing) holder.append(document.createTextNode(trailing));
    cursor = match.index + match[0].length;
  }
  holder.append(document.createTextNode(source.slice(cursor)));
  return holder.innerHTML;
}

function stripHtml(html) {
  return new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent || '';
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        reg.update();
        console.log('[SW] Registered:', reg.scope);
      })
      .catch((err) => console.warn('[SW] Registration failed:', err));
  }
}

// ─── START ───────────────────────────────────────────────────────────────

init();

const overlayAuthBtn = $('overlay-auth-btn');
if (overlayAuthBtn) {
  overlayAuthBtn.addEventListener('click', handleAuth);
}

