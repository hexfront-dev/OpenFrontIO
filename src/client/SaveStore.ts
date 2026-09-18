import {
  type SavedGame,
  type SavedGameHead,
  savedGameHeadFrom,
  SavedGameHeadSchema,
  type SavedGameMeta,
  savedGameMetaFromHead,
  SavedGameMetaSchema,
  SavedGameSchema,
  type Turn,
  TurnSchema,
} from "../core/Schemas";

const DB_NAME = "openfront-saves";
const DB_VERSION = 2;
const SAVE_STORE = "saves";
const META_STORE = "meta";
// B0: turns live in their own store keyed [saveId, turnNumber], so an autosave
// appends only the turns since the last one instead of rewriting (and
// re-validating) the whole history.
const TURNS_STORE = "turns";

// Keep disk usage bounded: old autosaves are dropped once this many exist.
export const MAX_SAVES = 30;

export interface SaveBackend {
  putHead(head: SavedGameHead, meta: SavedGameMeta): Promise<void>;
  appendTurns(saveId: string, turns: Turn[]): Promise<void>;
  clearTurns(saveId: string): Promise<void>;
  get(saveId: string): Promise<SavedGame | undefined>;
  listMeta(): Promise<SavedGameMeta[]>;
  delete(saveId: string): Promise<void>;
}

// Rebuild a dense turn array (index == turnNumber) from the stored turn rows.
function densifyTurns(turns: Turn[], numTurns: number): Turn[] {
  const byNumber = new Map<number, Turn>();
  for (const turn of turns) {
    byNumber.set(turn.turnNumber, turn);
  }
  const dense: Turn[] = [];
  for (let i = 0; i < numTurns; i++) {
    dense.push(byNumber.get(i) ?? { turnNumber: i, intents: [] });
  }
  return dense;
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

interface StoredTurn extends Turn {
  saveId: string;
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
        if (!db.objectStoreNames.contains(TURNS_STORE)) {
          const turns = db.createObjectStore(TURNS_STORE, {
            keyPath: ["saveId", "turnNumber"],
          });
          turns.createIndex("bySave", "saveId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async putHead(head: SavedGameHead, meta: SavedGameMeta): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([SAVE_STORE, META_STORE], "readwrite");
    tx.objectStore(SAVE_STORE).put(head);
    tx.objectStore(META_STORE).put(meta);
    await transactionDone(tx);
  }

  async appendTurns(saveId: string, turns: Turn[]): Promise<void> {
    if (turns.length === 0) {
      return;
    }
    const db = await this.open();
    const tx = db.transaction(TURNS_STORE, "readwrite");
    const store = tx.objectStore(TURNS_STORE);
    for (const turn of turns) {
      store.put({ ...turn, saveId });
    }
    await transactionDone(tx);
  }

  async clearTurns(saveId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(TURNS_STORE, "readwrite");
    const store = tx.objectStore(TURNS_STORE);
    const range = IDBKeyRange.bound(
      [saveId, Number.MIN_SAFE_INTEGER],
      [saveId, Number.MAX_SAFE_INTEGER],
    );
    store.delete(range);
    await transactionDone(tx);
  }

  async get(saveId: string): Promise<SavedGame | undefined> {
    const db = await this.open();
    const tx = db.transaction([SAVE_STORE, TURNS_STORE], "readonly");
    const raw = await request<SavedGame | SavedGameHead | undefined>(
      tx.objectStore(SAVE_STORE).get(saveId),
    );
    if (raw === undefined) {
      return undefined;
    }
    // Legacy v1 saves (and full writes) embed the turns inline.
    if (Array.isArray((raw as SavedGame).turns)) {
      return raw as SavedGame;
    }
    const head = raw as SavedGameHead;
    const rows = await request<StoredTurn[]>(
      tx
        .objectStore(TURNS_STORE)
        .index("bySave")
        .getAll(IDBKeyRange.only(saveId)),
    );
    const { numTurns, ...rest } = head;
    return { ...rest, turns: densifyTurns(rows, numTurns) } as SavedGame;
  }

  async listMeta(): Promise<SavedGameMeta[]> {
    const db = await this.open();
    const tx = db.transaction(META_STORE, "readonly");
    return await request<SavedGameMeta[]>(tx.objectStore(META_STORE).getAll());
  }

  async delete(saveId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(
      [SAVE_STORE, META_STORE, TURNS_STORE],
      "readwrite",
    );
    tx.objectStore(SAVE_STORE).delete(saveId);
    tx.objectStore(META_STORE).delete(saveId);
    tx.objectStore(TURNS_STORE).delete(
      IDBKeyRange.bound(
        [saveId, Number.MIN_SAFE_INTEGER],
        [saveId, Number.MAX_SAFE_INTEGER],
      ),
    );
    await transactionDone(tx);
  }
}

export class MemorySaveBackend implements SaveBackend {
  private heads = new Map<string, SavedGameHead>();
  private metas = new Map<string, SavedGameMeta>();
  private turns = new Map<string, Map<number, Turn>>();

  async putHead(head: SavedGameHead, meta: SavedGameMeta): Promise<void> {
    this.heads.set(head.saveId, structuredClone(head));
    this.metas.set(meta.saveId, structuredClone(meta));
  }

  async appendTurns(saveId: string, turns: Turn[]): Promise<void> {
    const stored = this.turns.get(saveId) ?? new Map<number, Turn>();
    for (const turn of turns) {
      stored.set(turn.turnNumber, structuredClone(turn));
    }
    this.turns.set(saveId, stored);
  }

  async clearTurns(saveId: string): Promise<void> {
    this.turns.delete(saveId);
  }

  async get(saveId: string): Promise<SavedGame | undefined> {
    const head = this.heads.get(saveId);
    if (head === undefined) {
      return undefined;
    }
    const stored = this.turns.get(saveId);
    const rows = stored === undefined ? [] : [...stored.values()];
    const { numTurns, ...rest } = structuredClone(head);
    return { ...rest, turns: densifyTurns(rows, numTurns) };
  }

  async listMeta(): Promise<SavedGameMeta[]> {
    return [...this.metas.values()].map((m) => structuredClone(m));
  }

  async delete(saveId: string): Promise<void> {
    this.heads.delete(saveId);
    this.metas.delete(saveId);
    this.turns.delete(saveId);
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

// Full-save write (tests, one-shot callers): validates the whole save once and
// stores it. Autosave loops should use saveGameProgress instead.
export async function saveGame(save: SavedGame): Promise<void> {
  await saveGameProgress(savedGameHeadFrom(save), save.turns, true);
}

// B0 append-only progress write. Only the small head and `newTurns` are
// validated; `reset` clears any previously stored turns (start of a save).
export async function saveGameProgress(
  head: SavedGameHead,
  newTurns: Turn[],
  reset = false,
): Promise<void> {
  const parsedHead = SavedGameHeadSchema.parse(head);
  if (reset) {
    await backend.clearTurns(parsedHead.saveId);
  }
  const parsedTurns = TurnSchema.array().parse(newTurns);
  await backend.putHead(parsedHead, savedGameMetaFromHead(parsedHead));
  await backend.appendTurns(parsedHead.saveId, parsedTurns);
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
