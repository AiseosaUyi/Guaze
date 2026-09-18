/**
 * Local-first library of uploaded background images/videos, stored in
 * IndexedDB so a background picked once doesn't have to be re-picked from
 * disk on every new recording session. Nothing here ever leaves the device
 * — same "no cloud" principle as the rest of the app, just persisted
 * across page loads instead of dying with the tab's blob: URLs.
 */

const DB_NAME = "social-recorder-backgrounds";
const DB_VERSION = 1;
const STORE_NAME = "assets";
/** FIFO cap so the store can't grow without bound — old uploads age out
 * once a dozen newer ones exist. */
const MAX_ASSETS = 12;

export interface BackgroundAsset {
  id: string;
  kind: "image" | "video";
  name: string;
  blob: Blob;
  createdAt: number;
}

export type BackgroundAssetMeta = Omit<BackgroundAsset, "blob">;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open background library."));
  });
}

async function evictOldest(db: IDBDatabase): Promise<void> {
  const all = await new Promise<BackgroundAsset[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as BackgroundAsset[]);
    req.onerror = () => reject(req.error ?? new Error("Failed to read background library."));
  });
  if (all.length <= MAX_ASSETS) return;
  const excess = all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - MAX_ASSETS);
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    for (const a of excess) tx.objectStore(STORE_NAME).delete(a.id);
    // Best-effort cleanup only — a failed evict shouldn't break the save
    // that triggered it.
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Saves a newly uploaded file into the library. Fails soft — a save
 * failure (private browsing, storage quota, an unsupported browser) never
 * blocks using the background for the current session, it just won't be
 * remembered next time, and the caller gets `null` back to know that. */
export async function saveBackgroundAsset(
  kind: "image" | "video",
  file: Blob,
  name: string
): Promise<BackgroundAsset | null> {
  try {
    const db = await openDb();
    const asset: BackgroundAsset = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      name,
      blob: file,
      createdAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(asset);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to save background."));
    });
    await evictOldest(db);
    db.close();
    return asset;
  } catch {
    return null;
  }
}

/** Lists saved assets, newest first, without loading their (potentially
 * large) blob data — pair with getBackgroundAssetUrl to load one on demand
 * once the person actually picks it. */
export async function listBackgroundAssets(): Promise<BackgroundAssetMeta[]> {
  try {
    const db = await openDb();
    const all = await new Promise<BackgroundAsset[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result as BackgroundAsset[]);
      req.onerror = () => reject(req.error ?? new Error("Failed to list backgrounds."));
    });
    db.close();
    return all
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, kind, name, createdAt }) => ({ id, kind, name, createdAt }));
  } catch {
    return [];
  }
}

/** Loads one asset's Blob and hands back a fresh object URL the caller owns
 * (revoke it when the background changes away from it, same as any other
 * blob: URL in this app). */
export async function getBackgroundAssetUrl(
  id: string
): Promise<{ url: string; kind: "image" | "video" } | null> {
  try {
    const db = await openDb();
    const asset = await new Promise<BackgroundAsset | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result as BackgroundAsset | undefined);
      req.onerror = () => reject(req.error ?? new Error("Failed to load background."));
    });
    db.close();
    if (!asset) return null;
    return { url: URL.createObjectURL(asset.blob), kind: asset.kind };
  } catch {
    return null;
  }
}

export async function deleteBackgroundAsset(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to delete background."));
    });
    db.close();
  } catch {
    // best-effort
  }
}
