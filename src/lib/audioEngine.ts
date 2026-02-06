// Audio Engine - handles real audio playback using HTML5 Audio API
// Stores music in IndexedDB for offline access

const DB_NAME = 'iPodMusicDB';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';

export interface TrackMeta {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  fileName: string;
  mimeType: string;
  size: number;
  dateAdded: number;
  coverArt?: string; // base64 data URL
}

export interface StoredTrack extends TrackMeta {
  audioBlob: Blob;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTrackToDB(track: StoredTrack): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(track);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllTrackMeta(): Promise<TrackMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const results = (req.result as StoredTrack[]).map(({ audioBlob: _a, ...meta }) => meta);
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getTrackBlob(id: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => {
      const result = req.result as StoredTrack | undefined;
      resolve(result?.audioBlob ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTrackFromDB(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAllTracks(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Generate a unique ID
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// Extract metadata from audio file
export async function extractMetadata(file: File): Promise<{ duration: number; title: string; artist: string; album: string }> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    audio.src = url;

    // Parse filename for fallback metadata
    const nameParts = file.name.replace(/\.[^/.]+$/, '');
    const dashSplit = nameParts.split(' - ');
    let fallbackTitle = nameParts;
    let fallbackArtist = 'Unknown Artist';
    let fallbackAlbum = 'Unknown Album';

    if (dashSplit.length >= 2) {
      fallbackArtist = dashSplit[0].trim();
      fallbackTitle = dashSplit.slice(1).join(' - ').trim();
    }

    audio.addEventListener('loadedmetadata', () => {
      const duration = audio.duration || 0;
      URL.revokeObjectURL(url);
      resolve({
        duration,
        title: fallbackTitle,
        artist: fallbackArtist,
        album: fallbackAlbum,
      });
    });

    audio.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      resolve({
        duration: 0,
        title: fallbackTitle,
        artist: fallbackArtist,
        album: fallbackAlbum,
      });
    });
  });
}

// Audio Player class with full playback control
export class AudioPlayer {
  private audio: HTMLAudioElement;
  private currentObjectUrl: string | null = null;
  private _onTimeUpdate: ((time: number) => void) | null = null;
  private _onEnded: (() => void) | null = null;
  private _onPlay: (() => void) | null = null;
  private _onPause: (() => void) | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';

    this.audio.addEventListener('timeupdate', () => {
      this._onTimeUpdate?.(this.audio.currentTime);
    });

    this.audio.addEventListener('ended', () => {
      this._onEnded?.();
    });

    this.audio.addEventListener('play', () => {
      this._onPlay?.();
    });

    this.audio.addEventListener('pause', () => {
      this._onPause?.();
    });
  }

  set onTimeUpdate(cb: ((time: number) => void) | null) { this._onTimeUpdate = cb; }
  set onEnded(cb: (() => void) | null) { this._onEnded = cb; }
  set onPlay(cb: (() => void) | null) { this._onPlay = cb; }
  set onPause(cb: (() => void) | null) { this._onPause = cb; }

  async loadTrack(trackId: string): Promise<boolean> {
    try {
      if (this.currentObjectUrl) {
        URL.revokeObjectURL(this.currentObjectUrl);
        this.currentObjectUrl = null;
      }

      const blob = await getTrackBlob(trackId);
      if (!blob) return false;

      this.currentObjectUrl = URL.createObjectURL(blob);
      this.audio.src = this.currentObjectUrl;
      await this.audio.load();
      return true;
    } catch {
      return false;
    }
  }

  async play(): Promise<void> {
    try {
      await this.audio.play();
    } catch {
      // autoplay may be blocked
    }
  }

  pause(): void {
    this.audio.pause();
  }

  togglePlayPause(): void {
    if (this.audio.paused) {
      this.play();
    } else {
      this.pause();
    }
  }

  get isPlaying(): boolean {
    return !this.audio.paused;
  }

  get currentTime(): number {
    return this.audio.currentTime || 0;
  }

  get duration(): number {
    return this.audio.duration || 0;
  }

  seek(time: number): void {
    if (isFinite(time) && time >= 0) {
      this.audio.currentTime = Math.min(time, this.duration);
    }
  }

  get volume(): number {
    return this.audio.volume;
  }

  set volume(v: number) {
    this.audio.volume = Math.max(0, Math.min(1, v));
  }

  destroy(): void {
    this.audio.pause();
    this.audio.src = '';
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
    }
  }
}
