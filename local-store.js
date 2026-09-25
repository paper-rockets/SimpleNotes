// Device storage for notes waiting to sync. IndexedDB can retain audio Blobs;
// JSON/localStorage cannot. Records are scoped to the signed-in account.
const DB_NAME = 'simplenotes-local';
const DB_VERSION = 1;
const STORE = 'notes';

let databasePromise;

function database() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return databasePromise;
}

function keyFor(userId, noteId) {
  return `${userId}:${noteId}`;
}

async function transaction(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    let result;
    if (request) {
      request.onsuccess = () => { result = request.result; };
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Local save was interrupted'));
  });
}

export async function loadLocalRecords(userId) {
  const records = await transaction('readonly', store => store.getAll());
  return records.filter(record => record.userId === userId);
}

export function saveLocalRecord(userId, note, status) {
  return transaction('readwrite', store => store.put({
    key: keyFor(userId, note.id),
    userId,
    note,
    status,
  }));
}

export function removeLocalRecord(userId, noteId) {
  return transaction('readwrite', store => store.delete(keyFor(userId, noteId)));
}
