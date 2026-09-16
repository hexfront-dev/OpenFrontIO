import {
  SavedGame,
  SavedGameMeta,
  SavedGameMetaSchema,
  SavedGameSchema,
  savedGameMetaFrom,
} from "../core/Schemas";

const DB_NAME = "openfront-saves";
const DB_VERSION = 1;
const SAVE_STORE = "saves";
const META_STORE = "meta";

// Keep disk usage bounded: old autosaves are dropped once this many exist.
export const MAX_SAVES = 30;

export interface SaveBackend {
  put(save: SavedGame, meta: SavedGameMeta): Promise<void>;
  get(saveId: string): Promise<SavedGame | undefined>;
  listMeta(): Promise<SavedGameMeta[]>;
  delete(saveId: string): Promise<void>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

class IndexedDbSaveBackend implements SaveBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SAVE_STORE)) {
          db.createObjectStore(SAVE_STORE, { keyPath: "saveId" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "saveId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async put(save: SavedGame, meta: SavedGameMeta): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([SAVE_STORE, META_STORE], "readwrite");
    tx.objectStore(SAVE_STORE).put(save);
    tx.objectStore(META_STORE).put(meta);
    await transactionDone(tx);
  }

  async get(saveId: string): Promise<SavedGame | undefined> {
    const db = await this.open();
    const tx = db.transaction(SAVE_STORE, "readonly");
    const result = await request<SavedGame | undefined>(
      tx.objectStore(SAVE_STORE).get(saveId),
    );
    return result;
  }

  async listMeta(): Promise<SavedGameMeta[]> {
    const db = await this.open();
    const tx = db.transaction(META_STORE, "readonly");
    return await request<SavedGameMeta[]>(tx.objectStore(META_STORE).getAll());
  }

  async delete(saveId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([SAVE_STORE, META_STORE], "readwrite");
    tx.objectStore(SAVE_STORE).delete(saveId);
    tx.objectStore(META_STORE).delete(saveId);
    await transactionDone(tx);
  }
}

export class MemorySaveBackend implements SaveBackend {
  private saves = new Map<string, SavedGame>();
  private metas = new Map<string, SavedGameMeta>();

  async put(save: SavedGame, meta: SavedGameMeta): Promise<void> {
    this.saves.set(save.saveId, structuredClone(save));
    this.metas.set(meta.saveId, structuredClone(meta));
  }

  async get(saveId: string): Promise<SavedGame | undefined> {
    const save = this.saves.get(saveId);
    return save === undefined ? undefined : structuredClone(save);
  }

  async listMeta(): Promise<SavedGameMeta[]> {
    return [...this.metas.values()].map((m) => structuredClone(m));
  }

  async delete(saveId: string): Promise<void> {
    this.saves.delete(saveId);
    this.metas.delete(saveId);
  }
}

function createDefaultBackend(): SaveBackend {
  if (typeof indexedDB !== "undefined") {
    return new IndexedDbSaveBackend();
  }
  return new MemorySaveBackend();
}

let backend: SaveBackend = createDefaultBackend();

export function setSaveBackend(next: SaveBackend): void {
  backend = next;
}

export function resetSaveBackend(): void {
  backend = createDefaultBackend();
}

export async function saveGame(save: SavedGame): Promise<void> {
  const parsed = SavedGameSchema.parse(save);
  const meta = savedGameMetaFrom(parsed);
  await backend.put(parsed, meta);
  await enforceCap();
}

export async function listSaves(): Promise<SavedGameMeta[]> {
  const metas = (await backend.listMeta()).map((m) =>
    SavedGameMetaSchema.parse(m),
  );
  return metas.sort((a, b) => b.savedAt - a.savedAt);
}

export async function loadSave(saveId: string): Promise<SavedGame | undefined> {
  const raw = await backend.get(saveId);
  if (raw === undefined) {
    return undefined;
  }
  return SavedGameSchema.parse(raw);
}

export async function deleteSave(saveId: string): Promise<void> {
  await backend.delete(saveId);
}

async function enforceCap(): Promise<void> {
  const metas = await listSaves();
  if (metas.length <= MAX_SAVES) {
    return;
  }
  for (const meta of metas.slice(MAX_SAVES)) {
    await backend.delete(meta.saveId);
  }
}
