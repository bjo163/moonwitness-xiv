export type PersistedWhatsappDraft = {
  text: string;
  file?: {
    blob: Blob;
    name: string;
    type: string;
    lastModified: number;
  };
};

type StoredDraft = PersistedWhatsappDraft & { id: string };

const DATABASE_NAME = 'moonwitness-whatsapp-drafts';
const STORE_NAME = 'drafts';

function openDraftDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new Error('Local draft storage is unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME))
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open local draft storage'));
    request.onblocked = () => reject(new Error('Local draft storage is busy'));
  });
}

async function withDraftStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDraftDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result: T | undefined;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error('Local draft storage failed'));
      transaction.oncomplete = () => resolve(result as T);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Local draft storage failed'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Local draft storage failed'));
    });
  } finally {
    database.close();
  }
}

export function readWhatsappDraft(id: string): Promise<PersistedWhatsappDraft | undefined> {
  return withDraftStore('readonly', (store) => store.get(id));
}

export async function writeWhatsappDraft(id: string, draft: PersistedWhatsappDraft): Promise<void> {
  if (!draft.text && !draft.file) {
    await deleteWhatsappDraft(id);
    return;
  }
  await withDraftStore('readwrite', (store) => store.put({ ...draft, id } satisfies StoredDraft));
}

export async function deleteWhatsappDraft(id: string): Promise<void> {
  await withDraftStore('readwrite', (store) => store.delete(id));
}
