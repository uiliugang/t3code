import {
  createProjectFaviconCache,
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
} from "@t3tools/client-runtime/project-favicon-cache";

const DATABASE_NAME = "t3code:project-favicons";
const DATABASE_VERSION = 2;
const STORE_NAME = "images";
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      for (const name of request.result.objectStoreNames) {
        if (name !== STORE_NAME) request.result.deleteObjectStore(name);
      }
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    const failed = (error: unknown) => {
      abandoned = true;
      reject(error);
    };
    request.addEventListener("success", () => {
      const connection = request.result;
      if (abandoned) {
        connection.close();
        return;
      }
      const invalidate = () => {
        if (database === opening) database = undefined;
      };
      connection.addEventListener("versionchange", () => {
        invalidate();
        connection.close();
      });
      connection.addEventListener("close", invalidate);
      resolve(connection);
    });
    request.addEventListener("error", () => failed(request.error));
    request.addEventListener("blocked", () => failed(new Error("Project icon cache is blocked.")));
  });
  database = opening;
  void opening.catch(() => {
    if (database === opening) database = undefined;
  });
  return opening;
}

function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
) {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await completed(transaction);
  return request?.result;
}

async function downscaleProjectFavicon(
  image: { readonly mimeType: string; readonly bytes: Uint8Array<ArrayBuffer> },
  signal: AbortSignal,
) {
  const bitmap = await createImageBitmap(new Blob([image.bytes], { type: image.mimeType }));
  try {
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    for (const size of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
      const scale = Math.min(1, size / bitmap.width, size / bitmap.height);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/webp", 0.85);
      if (dataUrl.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return dataUrl;
    }
    throw new Error("Project icon thumbnail exceeds the cache limit.");
  } finally {
    bitmap.close();
  }
}

export const projectFaviconCache = createProjectFaviconCache({
  storage: {
    list: async () => (await withStore("readonly", (store) => store.getAll())) ?? [],
    put: async (key, entry) => {
      await withStore("readwrite", (store) => store.put(entry, key));
    },
    remove: async (key) => {
      await withStore("readwrite", (store) => store.delete(key));
    },
  },
  load: createProjectFaviconImageLoader({ downscale: downscaleProjectFavicon }),
});
