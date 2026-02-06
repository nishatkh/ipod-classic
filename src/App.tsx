import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioPlayer,
  type TrackMeta,
  type StoredTrack,
  getAllTrackMeta,
  saveTrackToDB,
  clearAllTracks,
  extractMetadata,
  generateId,
} from "./lib/audioEngine";

// ─── Types ────────────────────────────────────────────────────────
type ScreenId =
  | "root" | "music" | "artists" | "albums" | "songs"
  | "nowPlaying" | "coverFlow" | "settings" | "addMusic" | "volume" | "about";

type MenuItem = {
  id: string;
  label: string;
  rightLabel?: string;
  action: () => void;
};

// ─── Global Declarations ────────────────────────────────────────────
declare global {
  interface Window {
    deferredPrompt: any;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function pad2(n: number) { return String(n).padStart(2, "0"); }
function fmtTime(sec: number) { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; }
function uniqueSorted(arr: string[]) { return [...new Set(arr)].sort((a, b) => a.localeCompare(b)); }

const COLORS: [string, string][] = [
  ["#0ea5e9","#6366f1"],["#f97316","#ef4444"],["#10b981","#22c55e"],
  ["#eab308","#f59e0b"],["#a855f7","#ec4899"],["#14b8a6","#06b6d4"],
  ["#64748b","#334155"],["#fb7185","#f43f5e"],["#8b5cf6","#7c3aed"],
  ["#f472b6","#db2777"],["#34d399","#059669"],["#fbbf24","#d97706"],
];

function trackColors(t: TrackMeta): [string, string] {
  let hash = 0;
  for (let i = 0; i < t.id.length; i++) hash = ((hash << 5) - hash + t.id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

function angleDeg(cx: number, cy: number, x: number, y: number) {
  return ((Math.atan2(y - cy, x - cx) * 180) / Math.PI + 90 + 360) % 360;
}
function signedDelta(a: number, b: number) { return ((b - a + 540) % 360) - 180; }

function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

// ─── Album Art ────────────────────────────────────────────────────
function AlbumArt({ track, size, className = "" }: { track: TrackMeta; size: number; className?: string }) {
  const [c1, c2] = trackColors(track);
  if (track.coverArt) {
    return <img src={track.coverArt} alt={track.album} className={`rounded-lg object-cover shadow-lg ${className}`} style={{ width: size, height: size }} />;
  }
  return (
    <div className={`relative flex items-center justify-center rounded-lg shadow-lg ${className}`} style={{ width: size, height: size, background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
      <div className="text-white/90 font-bold" style={{ fontSize: size * 0.3 }}>♪</div>
      <div className="absolute inset-0 rounded-lg" style={{ background: "radial-gradient(70% 70% at 25% 20%, rgba(255,255,255,0.4), transparent 55%)" }} />
    </div>
  );
}

// ─── Status Bar ───────────────────────────────────────────────────
function StatusBar({ title, showBack }: { title: string; showBack?: boolean }) {
  return (
    <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-black/10 bg-gradient-to-b from-[#e8e8ec] to-[#d4d4d8] px-2.5 text-[11px] font-bold text-black/80">
      <div className="flex items-center gap-1 min-w-[50px]">
        {showBack && <span className="text-[10px]">◀</span>}
        <span className="tracking-tight">iPod</span>
      </div>
      <div className="truncate px-1 text-center text-[11px] font-bold">{title}</div>
      <div className="flex items-center gap-1 min-w-[50px] justify-end">
        <div className="flex items-center gap-[1px]">
          <div className="w-[14px] h-[8px] rounded-[1px] border border-black/40 relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 bg-black/60" style={{ width: "85%" }} />
          </div>
          <div className="w-[2px] h-[4px] bg-black/40 rounded-r-[1px]" />
        </div>
      </div>
    </div>
  );
}

// ─── Menu List ────────────────────────────────────────────────────
function MenuListView({ items, selectedIndex, scrollOffset, onItemClick }: { items: MenuItem[]; selectedIndex: number; scrollOffset: number; onItemClick: (i: number) => void }) {
  const visible = items.slice(scrollOffset, scrollOffset + 7);
  return (
    <div className="bg-white flex-1 overflow-hidden">
      {visible.length === 0 && <div className="p-4 text-center text-[12px] text-black/50">No items</div>}
      {visible.map((it, i) => {
        const idx = scrollOffset + i;
        const sel = idx === selectedIndex;
        return (
          <div key={it.id + i} onClick={() => onItemClick(idx)} className={"flex h-[28px] items-center justify-between px-3 text-[12px] cursor-pointer active:opacity-70 " + (sel ? "bg-gradient-to-b from-[#4a90d9] to-[#2a6cb8] text-white" : "text-black/90 border-b border-black/[0.04]")}>
            <span className="truncate font-medium">{it.label}</span>
            <span className={sel ? "text-white/80 text-[11px]" : "text-black/40 text-[11px]"}>{it.rightLabel ?? "›"}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Now Playing ──────────────────────────────────────────────────
function NowPlayingView({ track, isPlaying, currentTime, dur, vol, onSeek, onVolume }: { track: TrackMeta; isPlaying: boolean; currentTime: number; dur: number; vol: number; onSeek: (time: number) => void; onVolume: (vol: number) => void }) {
  const pct = dur > 0 ? clamp(currentTime / dur, 0, 1) : 0;
  
  const handleProgress = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    if (dur <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    onSeek((x / rect.width) * dur);
  };

  return (
    <div className="flex flex-col h-full bg-white">
      <StatusBar title="Now Playing" showBack />
      <div className="flex-1 flex flex-col p-3 gap-2 overflow-hidden">
        <div className="flex gap-3 items-start">
          <div className="shrink-0"><AlbumArt track={track} size={80} className={isPlaying ? "animate-pulse-slow" : ""} /></div>
          <div className="min-w-0 flex-1 pt-1">
            <div className="truncate text-[13px] font-bold text-black">{track.title}</div>
            <div className="truncate text-[11px] font-semibold text-black/65 mt-0.5">{track.artist}</div>
            <div className="truncate text-[11px] text-black/50">{track.album}</div>
            <div className="mt-2 flex items-center gap-1.5">
              <div className="text-[16px] text-black/60">{isPlaying ? "▶" : "❚❚"}</div>
              <div className="text-[10px] text-black/40 font-medium">{isPlaying ? "Playing" : "Paused"}</div>
            </div>
          </div>
        </div>
        <div className="mt-1">
          <div 
            className="h-[16px] -my-[5px] w-full flex items-center cursor-pointer touch-none"
            onClick={handleProgress}
            onTouchStart={handleProgress}
            onTouchMove={(e) => { if(e.cancelable) e.preventDefault(); handleProgress(e); }}
          >
            <div className="h-[6px] w-full rounded-full bg-black/10 overflow-hidden shadow-inner pointer-events-none">
              <div className="h-full rounded-full bg-gradient-to-r from-[#4a90d9] to-[#2a6cb8] transition-[width] duration-75" style={{ width: `${pct * 100}%` }} />
            </div>
          </div>
          <div className="flex justify-between text-[10px] font-semibold text-black/55 mt-0.5">
            <span>{fmtTime(currentTime)}</span>
            <span>-{fmtTime(Math.max(0, dur - currentTime))}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-black/40">🔈</span>
          <div 
            className="flex-1 h-[20px] -my-[8px] flex items-center cursor-pointer touch-none"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onVolume(Math.max(0, Math.min((e.clientX - r.left) / r.width, 1))); }}
            onTouchStart={(e) => { const r = e.currentTarget.getBoundingClientRect(); onVolume(Math.max(0, Math.min((e.touches[0].clientX - r.left) / r.width, 1))); }}
            onTouchMove={(e) => { if(e.cancelable) e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); onVolume(Math.max(0, Math.min((e.touches[0].clientX - r.left) / r.width, 1))); }}
          >
            <div className="w-full h-[4px] rounded-full bg-black/10 overflow-hidden shadow-inner pointer-events-none">
              <div className="h-full rounded-full bg-black/30 transition-[width] duration-75" style={{ width: `${vol * 100}%` }} />
            </div>
          </div>
          <span className="text-[10px] text-black/40">🔊</span>
        </div>
        <div className="mt-auto grid grid-cols-3 text-center text-[10px] font-bold text-black/40">
          <div>⏮ Prev</div><div>{isPlaying ? "❚❚ Pause" : "▶ Play"}</div><div>Next ⏭</div>
        </div>
      </div>
    </div>
  );
}

// ─── Cover Flow ───────────────────────────────────────────────────
function CoverFlowView({ tracks, selectedIndex }: { tracks: TrackMeta[]; selectedIndex: number }) {
  const center = clamp(selectedIndex, 0, Math.max(0, tracks.length - 1));
  if (tracks.length === 0) {
    return <div className="flex flex-col h-full bg-[#1a1a1a]"><StatusBar title="Cover Flow" /><div className="flex-1 flex items-center justify-center text-[12px] text-white/50">No music yet — add tracks first!</div></div>;
  }
  const ws = 7;
  const start = clamp(center - 3, 0, Math.max(0, tracks.length - ws));
  const slice = tracks.slice(start, start + ws);
  const lc = center - start;

  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-[#2a2a2a] to-[#0a0a0a] overflow-hidden">
      <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-white/10 px-2.5 text-[11px] font-bold text-white/80">
        <span>◀</span><span>Cover Flow</span><span className="text-[10px]">{center + 1}/{tracks.length}</span>
      </div>
      <div className="flex-1 relative" style={{ perspective: "600px" }}>
        <div className="absolute inset-x-0 top-6 flex items-center justify-center">
          {slice.map((t, i) => {
            const d = i - lc, abs = Math.abs(d);
            const sc = clamp(1 - abs * 0.1, 0.65, 1), x = d * 56;
            const ry = clamp(d * -45, -65, 65), z = 100 - abs * 20, op = clamp(1 - abs * 0.2, 0.3, 1);
            const isCtr = d === 0;
            const [c1, c2] = trackColors(t);
            return (
              <div key={t.id} className="absolute" style={{ transform: `translateX(${x}px) scale(${sc}) rotateY(${ry}deg)`, transformStyle: "preserve-3d", zIndex: z, opacity: op, transition: "all 0.25s ease-out" }}>
                {t.coverArt
                  ? <img src={t.coverArt} alt="" className={`w-[72px] h-[72px] rounded-md object-cover ${isCtr ? "ring-2 ring-white/80 shadow-2xl" : "shadow-lg"}`} />
                  : <div className={`w-[72px] h-[72px] rounded-md flex items-center justify-center ${isCtr ? "ring-2 ring-white/80 shadow-2xl" : "shadow-lg"}`} style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}><span className="text-white/80 text-2xl">♪</span></div>
                }
                <div className="mt-[2px] w-[72px] h-[36px] rounded-md overflow-hidden" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, transform: "scaleY(-1)", opacity: 0.15, filter: "blur(1px)", maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.5), transparent)", WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,0.5), transparent)" }} />
              </div>
            );
          })}
        </div>
        <div className="absolute inset-x-0 bottom-3 px-4 text-center">
          <div className="truncate text-[13px] font-bold text-white">{tracks[center]?.title}</div>
          <div className="truncate text-[11px] text-white/60">{tracks[center]?.artist} — {tracks[center]?.album}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Add Music ────────────────────────────────────────────────────
function AddMusicView({ onFiles, busy, progress }: { onFiles: (f: FileList) => void; busy: boolean; progress: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const isDesktop = !(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));

  return (
    <div className="flex flex-col h-full bg-white">
      <StatusBar title="Add Music" showBack />
      <div className="flex-1 flex flex-col items-center justify-center p-3 gap-2 overflow-y-auto text-center">
        {busy ? (
          <><div className="animate-spin w-8 h-8 border-2 border-[#4a90d9] border-t-transparent rounded-full mb-2" /><div className="text-[11px] font-bold text-black/70 px-4 whitespace-pre-line leading-tight">{progress}</div></>
        ) : (
          <>
            <div className="text-3xl mb-1 mt-2">🎵</div>
            <div className="text-[12px] font-bold text-black/80 leading-tight">Access Device Music</div>
            <div className="text-[10px] text-black/50 px-2 leading-tight mb-2">
              Browsers require your permission to access local audio files.
            </div>
            
            <div className="flex flex-col gap-2 w-full px-4 mt-1 pb-4">
              {isDesktop && (
                <button onClick={() => folderRef.current?.click()} className="w-full bg-gradient-to-b from-[#4a90d9] to-[#2a6cb8] text-white text-[11px] font-bold py-2 rounded shadow-sm active:opacity-80 flex items-center justify-center gap-1">
                  <span>📁</span> Grant Folder Access
                </button>
              )}
              <button onClick={() => fileRef.current?.click()} className="w-full bg-gradient-to-b from-[#e8e8ec] to-[#d4d4d8] text-black/80 border border-black/10 text-[11px] font-bold py-2 rounded shadow-sm active:opacity-80 flex items-center justify-center gap-1">
                <span>📄</span> Select Audio Files
              </button>
            </div>

            <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac" multiple className="hidden" onChange={e => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ''; }} />
            {/* @ts-ignore - webkitdirectory is non-standard but widely supported */}
            <input ref={folderRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac" webkitdirectory="" directory="" className="hidden" onChange={e => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = ''; }} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Click Wheel ──────────────────────────────────────────────────
function ClickWheel({ wheelRef, onMenu, onCenter, onPrev, onNext, onPlayPause }: {
  wheelRef: { current: HTMLDivElement | null }; onMenu: () => void; onCenter: () => void; onPrev: () => void; onNext: () => void; onPlayPause: () => void;
}) {
  return (
    <div className="flex items-center justify-center mt-4">
      <div ref={wheelRef} className="relative w-52 h-52 rounded-full touch-none select-none cursor-grab active:cursor-grabbing" style={{ background: "radial-gradient(circle at 50% 40%, #f4f4f5, #d4d4d8 70%, #a1a1aa 100%)", boxShadow: "inset 0 2px 3px rgba(255,255,255,0.9), inset 0 -8px 16px rgba(0,0,0,0.12), 0 12px 32px rgba(0,0,0,0.2), 0 2px 6px rgba(0,0,0,0.15)" }} aria-label="Click wheel">
        <div className="absolute inset-0 rounded-full opacity-[0.03]" style={{ background: "repeating-conic-gradient(transparent 0deg, transparent 8deg, rgba(0,0,0,0.3) 9deg, transparent 10deg)" }} />
        <button type="button" data-button="menu" onClick={onMenu} className="absolute left-1/2 top-5 -translate-x-1/2 text-[10px] font-bold tracking-[0.1em] text-black/50 hover:text-black/80 px-3 py-1">MENU</button>
        <button type="button" data-button="prev" onClick={onPrev} className="absolute left-4 top-1/2 -translate-y-1/2 text-[14px] text-black/50 hover:text-black/80 p-2">⏮</button>
        <button type="button" data-button="next" onClick={onNext} className="absolute right-4 top-1/2 -translate-y-1/2 text-[14px] text-black/50 hover:text-black/80 p-2">⏭</button>
        <button type="button" data-button="play" onClick={onPlayPause} className="absolute bottom-5 left-1/2 -translate-x-1/2 text-[12px] font-bold text-black/50 hover:text-black/80 px-3 py-1">▶❚❚</button>
        <button type="button" data-button="center" onClick={onCenter} className="absolute left-1/2 top-1/2 w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full active:shadow-inner" style={{ background: "radial-gradient(circle at 50% 40%, #fafafa, #d4d4d8 80%)", boxShadow: "inset 0 2px 4px rgba(255,255,255,0.95), inset 0 -6px 12px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.15)" }} aria-label="Select" />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ─── MAIN APP ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════
export function App() {
  const [tracks, setTracks] = useState<TrackMeta[]>([]);
  const [ready, setReady] = useState(false);

  const [stack, setStack] = useState<ScreenId[]>(["root"]);
  const current = stack[stack.length - 1];
  const [selMap, setSelMap] = useState<Record<string, number>>({});
  const [scrMap, setScrMap] = useState<Record<string, number>>({});
  const [fArtist, setFArtist] = useState<string | null>(null);
  const [fAlbum, setFAlbum] = useState<string | null>(null);

  const playerRef = useRef<AudioPlayer | null>(null);
  const [npId, setNpId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(0.8);

  const [importing, setImporting] = useState(false);
  const [importProg, setImportProg] = useState("");

  const wheelRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const touchState = useRef({ y: 0, x: 0, acc: 0 });

  // Refs for callbacks that need latest state
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const npIdRef = useRef(npId);
  npIdRef.current = npId;

  const npTrack = useMemo(() => tracks.find(t => t.id === npId) ?? null, [tracks, npId]);
  const sorted = useMemo(() => [...tracks].sort((a, b) => a.title.localeCompare(b.title)), [tracks]);
  const artList = useMemo(() => uniqueSorted(tracks.map(t => t.artist)), [tracks]);
  const albList = useMemo(() => uniqueSorted(tracks.map(t => t.album)), [tracks]);
  const filtered = useMemo(() => {
    let l = sorted;
    if (fArtist) l = l.filter(t => t.artist === fArtist);
    if (fAlbum) l = l.filter(t => t.album === fAlbum);
    return l;
  }, [sorted, fArtist, fAlbum]);

  // ── helpers ──
  const gs = useCallback((k: string) => selMap[k] ?? 0, [selMap]);
  const ss = useCallback((k: string, v: number) => setSelMap(p => ({ ...p, [k]: v })), []);
  const gsc = useCallback((k: string) => scrMap[k] ?? 0, [scrMap]);
  const ssc = useCallback((k: string, v: number) => setScrMap(p => ({ ...p, [k]: v })), []);
  const push = useCallback((to: ScreenId) => setStack(s => [...s, to]), []);
  const pop = useCallback(() => setStack(s => s.length > 1 ? s.slice(0, -1) : s), []);

  // ── Play a track ──
  const playTrack = useCallback(async (id: string) => {
    const p = playerRef.current;
    if (!p) return;
    if (await p.loadTrack(id)) {
      setNpId(id);
      setCurTime(0);
      setDur(0);
      await p.play();
    }
  }, []);

  // ── Next / Prev using refs for stable callback ──
  const doNext = useCallback(() => {
    const s = [...tracksRef.current].sort((a, b) => a.title.localeCompare(b.title));
    if (!s.length) return;
    const i = s.findIndex(t => t.id === npIdRef.current);
    playTrack(s[(i + 1) % s.length].id);
  }, [playTrack]);

  const doPrev = useCallback(() => {
    const s = [...tracksRef.current].sort((a, b) => a.title.localeCompare(b.title));
    if (!s.length) return;
    const p = playerRef.current;
    if (p && p.currentTime > 3) { p.seek(0); return; }
    const i = s.findIndex(t => t.id === npIdRef.current);
    playTrack(s[(i - 1 + s.length) % s.length].id);
  }, [playTrack]);

  // ── Init ──
  useEffect(() => {
    registerSW();

    const p = new AudioPlayer();
    p.volume = 0.8;
    playerRef.current = p;
    p.onTimeUpdate = (t) => { setCurTime(t); setDur(p.duration); };
    p.onPlay = () => setPlaying(true);
    p.onPause = () => setPlaying(false);
    p.onEnded = () => doNext();

    getAllTrackMeta().then(m => { setTracks(m.sort((a, b) => a.title.localeCompare(b.title))); setReady(true); });

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => p.play());
      navigator.mediaSession.setActionHandler("pause", () => p.pause());
      navigator.mediaSession.setActionHandler("nexttrack", () => doNext());
      navigator.mediaSession.setActionHandler("previoustrack", () => doPrev());
    }

    return () => {
      p.destroy();
    };
  }, [doNext, doPrev]);

  // MediaSession metadata
  useEffect(() => {
    if (npTrack && "mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: npTrack.title, artist: npTrack.artist, album: npTrack.album, artwork: npTrack.coverArt ? [{ src: npTrack.coverArt, sizes: "256x256", type: "image/png" }] : [] });
    }
  }, [npTrack]);

  // ── Import ──
  const doImport = useCallback(async (files: FileList) => {
    setImporting(true);
    
    // Filter to ensure only actual audio files are processed
    const validAudioFiles = Array.from(files).filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(f.name));
    
    if (validAudioFiles.length === 0) {
      alert("No audio files were found in your selection.");
      setImporting(false);
      return;
    }

    for (let i = 0; i < validAudioFiles.length; i++) {
      const f = validAudioFiles[i];
      setImportProg(`Adding ${i + 1}/${validAudioFiles.length}
${f.name.length > 20 ? f.name.slice(0, 20) + '...' : f.name}`);
      try {
        const m = await extractMetadata(f);
        const st: StoredTrack = { id: generateId(), title: m.title, artist: m.artist, album: m.album, duration: m.duration, fileName: f.name, mimeType: f.type, size: f.size, dateAdded: Date.now(), audioBlob: f };
        await saveTrackToDB(st);
      } catch { /* skip */ }
    }
    const all = await getAllTrackMeta();
    setTracks(all.sort((a, b) => a.title.localeCompare(b.title)));
    setImporting(false);
    setImportProg("");
    pop();
  }, [pop]);

  // ── Menu builder ──
  const menuData = useMemo((): { title: string; items: MenuItem[]; key: string } | null => {
    switch (current) {
      case "root": {
        const items: MenuItem[] = [
          { id: "music", label: "Music", rightLabel: `${tracks.length}`, action: () => push("music") },
          { id: "cf", label: "Cover Flow", action: () => push("coverFlow") },
          { id: "add", label: "Add Music", rightLabel: "+", action: () => push("addMusic") },
        ];
        if (npTrack) items.push({ id: "np", label: "Now Playing", rightLabel: "♪", action: () => push("nowPlaying") });
        items.push({ id: "set", label: "Settings", action: () => push("settings") }, { id: "abt", label: "About", action: () => push("about") });
        return { title: "iPod", items, key: "root" };
      }
      case "music": return { title: "Music", key: "music", items: [
        { id: "songs", label: "Songs", rightLabel: `${tracks.length}`, action: () => { setFArtist(null); setFAlbum(null); push("songs"); ss("songs", 0); ssc("songs", 0); } },
        { id: "art", label: "Artists", rightLabel: `${artList.length}`, action: () => { push("artists"); ss("artists", 0); ssc("artists", 0); } },
        { id: "alb", label: "Albums", rightLabel: `${albList.length}`, action: () => { push("albums"); ss("albums", 0); ssc("albums", 0); } },
        { id: "cf2", label: "Cover Flow", action: () => push("coverFlow") },
      ]};
      case "artists": return { title: "Artists", key: "artists", items: artList.map(a => ({ id: `a:${a}`, label: a, rightLabel: `${tracks.filter(t => t.artist === a).length}`, action: () => { setFArtist(a); setFAlbum(null); push("songs"); ss("songs", 0); ssc("songs", 0); } })) };
      case "albums": return { title: "Albums", key: "albums", items: albList.map(a => ({ id: `b:${a}`, label: a, rightLabel: `${tracks.filter(t => t.album === a).length}`, action: () => { setFAlbum(a); setFArtist(null); push("songs"); ss("songs", 0); ssc("songs", 0); } })) };
      case "songs": return { title: fArtist || fAlbum || "Songs", key: "songs", items: filtered.map(t => ({ id: t.id, label: t.title, rightLabel: fmtTime(t.duration), action: () => { playTrack(t.id); push("nowPlaying"); } })) };
      case "settings": return { title: "Settings", key: "settings", items: [
        { id: "v", label: "Volume", rightLabel: `${Math.round(vol * 100)}%`, action: () => push("volume") },
        { id: "cl", label: "Clear Library", rightLabel: "⚠", action: async () => { if (!tracks.length) return; await clearAllTracks(); setTracks([]); playerRef.current?.pause(); setNpId(null); pop(); } },
      ]};
      case "about": {
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
        const items: MenuItem[] = [
          { id: "a1", label: "iPod Classic", rightLabel: "v1.0", action: () => {} },
          { id: "a2", label: `Songs: ${tracks.length}`, rightLabel: "", action: () => {} },
          { id: "a3", label: "Storage: Local", rightLabel: "✓", action: () => {} },
          { id: "a4", label: "Offline Mode", rightLabel: "✓", action: () => {} }
        ];
        if (!isStandalone) {
          items.push({ id: "a6", label: "Install App", rightLabel: "📥", action: () => {
            if (window.deferredPrompt) {
              window.deferredPrompt.prompt();
              window.deferredPrompt.userChoice.then(() => { window.deferredPrompt = null; });
            } else {
              alert("Install via browser menu.");
            }
          }});
        }
        return { title: "About", key: "about", items };
      }
      default: return null;
    }
  }, [current, tracks, artList, albList, filtered, npTrack, vol, fArtist, fAlbum, push, pop, ss, ssc, playTrack]);

  const selKey = menuData?.key ?? current;
  const sel = clamp(gs(selKey), 0, Math.max(0, (menuData?.items.length ?? 1) - 1));
  const scr = gsc(selKey);

  // ── Click wheel increment ──
  const handleInc = useCallback((d: number) => {
    if (current === "nowPlaying") { const nv = clamp(vol + d * 0.05, 0, 1); setVol(nv); if (playerRef.current) playerRef.current.volume = nv; return; }
    if (current === "volume") { const nv = clamp(vol + d * 0.05, 0, 1); setVol(nv); if (playerRef.current) playerRef.current.volume = nv; return; }
    if (current === "coverFlow") { ss("coverFlow", clamp(gs("coverFlow") + d, 0, Math.max(0, sorted.length - 1))); return; }
    if (!menuData) return;
    const len = menuData.items.length; if (!len) return;
    const cur = clamp(gs(selKey), 0, len - 1);
    const nxt = clamp(cur + d, 0, len - 1);
    ss(selKey, nxt);
    const cs = gsc(selKey);
    let ns = cs;
    if (nxt < cs) ns = nxt;
    if (nxt >= cs + 7) ns = nxt - 6;
    ssc(selKey, clamp(ns, 0, Math.max(0, len - 7)));
  }, [current, menuData, selKey, gs, ss, gsc, ssc, vol, sorted.length]);

  const handleSel = useCallback(() => {
    if (current === "nowPlaying") { playerRef.current?.togglePlayPause(); return; }
    if (current === "coverFlow") { const i = clamp(gs("coverFlow"), 0, sorted.length - 1); if (sorted[i]) { playTrack(sorted[i].id); push("nowPlaying"); } return; }
    if (current === "volume") { pop(); return; }
    if (!menuData) return;
    const i = clamp(gs(selKey), 0, menuData.items.length - 1);
    menuData.items[i]?.action();
  }, [current, menuData, selKey, gs, sorted, playTrack, push, pop]);

  const handleMenu = useCallback(() => {
    if (current === "songs") { setFArtist(null); setFAlbum(null); }
    pop();
  }, [current, pop]);

  const handlePP = useCallback(() => {
    if (!npId && sorted.length) { playTrack(sorted[0].id); push("nowPlaying"); return; }
    if (current !== "nowPlaying" && npId) { push("nowPlaying"); return; }
    playerRef.current?.togglePlayPause();
  }, [current, npId, sorted, playTrack, push]);

  // ── Wheel Interaction ──
  useEffect(() => {
    const el = wheelRef.current; if (!el) return;
    let drag = false, la: number | null = null, acc = 0;

    const getPos = (e: Event) => {
      if (typeof TouchEvent !== "undefined" && e instanceof TouchEvent) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      return { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
    };

    const down = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target?.closest?.('[data-button]')) return;
      if (e.cancelable) e.preventDefault();
      drag = true;
      const pos = getPos(e);
      const r = el.getBoundingClientRect();
      la = angleDeg(r.left + r.width / 2, r.top + r.height / 2, pos.x, pos.y);
      acc = 0;
    };

    const move = (e: Event) => {
      if (!drag) return;
      if (e.cancelable) e.preventDefault();
      const pos = getPos(e);
      const r = el.getBoundingClientRect();
      const a = angleDeg(r.left + r.width / 2, r.top + r.height / 2, pos.x, pos.y);
      if (la === null) { la = a; return; }
      acc += signedDelta(la, a);
      la = a;
      let s = 0;
      while (acc >= 15) { acc -= 15; s++; }
      while (acc <= -15) { acc += 15; s--; }
      if (s) handleInc(s);
    };

    const up = () => { drag = false; la = null; acc = 0; };

    el.addEventListener("mousedown", down, { passive: false });
    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("mouseup", up);

    el.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);

    return () => {
      el.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      el.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [handleInc]);

  // ── Keyboard ──
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (["ArrowUp","ArrowDown","Enter","Escape"," ","Backspace","ArrowLeft","ArrowRight"].includes(e.key)) e.preventDefault();
      switch (e.key) { case "ArrowUp": handleInc(-1); break; case "ArrowDown": handleInc(1); break; case "Enter": handleSel(); break; case "Escape": case "Backspace": handleMenu(); break; case " ": handlePP(); break; case "ArrowLeft": doPrev(); break; case "ArrowRight": doNext(); break; }
    };
    window.addEventListener("keydown", fn, { passive: false });
    return () => window.removeEventListener("keydown", fn);
  }, [handleInc, handleSel, handleMenu, handlePP, doPrev, doNext]);

  const dragState = useRef(false);

  const handleItemClick = useCallback((index: number) => {
    if (dragState.current) return;
    ss(selKey, index);
    if (menuData && menuData.items[index]) {
      menuData.items[index].action();
    }
  }, [selKey, ss, menuData]);

  // ── Screen renderer ──
  const screen = () => {
    if (!ready) return <div className="flex flex-col h-full bg-white items-center justify-center"><div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full mb-2" /><div className="text-[11px] text-black/50">Loading…</div></div>;
    if (current === "nowPlaying" && npTrack) return <NowPlayingView track={npTrack} isPlaying={playing} currentTime={curTime} dur={dur} vol={vol} onSeek={(t) => playerRef.current?.seek(t)} onVolume={(v) => { setVol(v); if(playerRef.current) playerRef.current.volume = v; }} />;
    if (current === "coverFlow") return <CoverFlowView tracks={sorted} selectedIndex={gs("coverFlow")} />;
    if (current === "addMusic") return <AddMusicView onFiles={doImport} busy={importing} progress={importProg} />;
    if (current === "volume") return (
      <div className="flex flex-col h-full bg-white">
        <StatusBar title="Volume" showBack />
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-4">
          <div className="text-4xl">🔊</div>
          <div className="text-[28px] font-bold text-black/80">{Math.round(vol * 100)}%</div>
          <div className="w-full px-6"><div className="flex items-center gap-3"><span className="text-[12px]">🔈</span><div className="flex-1 h-[8px] rounded-full bg-black/10 overflow-hidden shadow-inner"><div className="h-full rounded-full bg-gradient-to-r from-[#4a90d9] to-[#2a6cb8]" style={{ width: `${vol * 100}%` }} /></div><span className="text-[12px]">🔊</span></div></div>
          <div className="text-[10px] text-black/40">Swipe or rotate to adjust</div>
        </div>
      </div>
    );
    if (menuData) return <div className="flex flex-col h-full bg-white"><StatusBar title={menuData.title} showBack={stack.length > 1} /><MenuListView items={menuData.items} selectedIndex={sel} scrollOffset={scr} onItemClick={handleItemClick} /></div>;
    return <div className="flex flex-col h-full bg-white items-center justify-center text-[12px] text-black/50">Unknown</div>;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-200 via-zinc-100 to-zinc-300 flex items-center justify-center p-4" style={{ touchAction: "none", userSelect: "none" }}>
      <div className="w-full max-w-[380px]">
        {/* iPod Body */}
        <div className="rounded-[40px] p-5" style={{ background: "linear-gradient(180deg, #f0f0f2 0%, #d8d8dc 30%, #c8c8cc 70%, #b8b8bc 100%)", boxShadow: "inset 0 2px 4px rgba(255,255,255,0.9), inset 0 -2px 4px rgba(0,0,0,0.1), 0 20px 60px rgba(0,0,0,0.3), 0 4px 12px rgba(0,0,0,0.15)" }}>
          <div className="rounded-[32px] p-4" style={{ background: "linear-gradient(180deg, #e8e8ec, #d0d0d4)", boxShadow: "inset 0 1px 2px rgba(255,255,255,0.6), inset 0 -1px 2px rgba(0,0,0,0.08)" }}>
            {/* Speaker */}
            <div className="flex justify-center mb-3"><div className="flex gap-[2px]">{Array.from({ length: 12 }).map((_, i) => <div key={i} className="w-[2px] h-[2px] rounded-full bg-black/15" />)}</div></div>

            {/* Screen */}
            <div 
              ref={screenRef}
              className="rounded-[12px] overflow-hidden shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15),_0_2px_8px_rgba(0,0,0,0.12)]" 
              style={{ height: 240, background: "#fff", touchAction: "none" }}
              onWheel={(e) => {
                if (Math.abs(e.deltaY) > 10) handleInc(e.deltaY > 0 ? 1 : -1);
              }}
              onTouchStart={(e) => {
                const touch = e.touches[0];
                touchState.current = { y: touch.clientY, x: touch.clientX, acc: 0 };
                dragState.current = false;
              }}
              onTouchMove={(e) => {
                const t = e.target as HTMLElement;
                if (!t.closest(".overflow-auto")) {
                  if (e.cancelable) e.preventDefault();
                }
                
                const touch = e.touches[0];
                const deltaY = touchState.current.y - touch.clientY;
                const deltaX = touchState.current.x - touch.clientX;
                
                if (Math.abs(deltaY) > 5 || Math.abs(deltaX) > 5) {
                  dragState.current = true;
                }
                
                const isHoriz = Math.abs(deltaX) > Math.abs(deltaY) && current === "coverFlow";
                const delta = isHoriz ? deltaX : deltaY;
                
                let acc = touchState.current.acc + delta;
                let steps = 0;
                while (acc >= 20) { acc -= 20; steps++; }
                while (acc <= -20) { acc += 20; steps--; }
                
                if (steps !== 0) {
                  handleInc(steps);
                }
                
                touchState.current.y = touch.clientY;
                touchState.current.x = touch.clientX;
                touchState.current.acc = acc;
              }}
              onTouchEnd={() => {
                setTimeout(() => dragState.current = false, 50);
              }}
            >
              {screen()}
            </div>

            {/* Model label */}
            <div className="flex justify-between items-center px-1 mt-2 mb-1">
              <div className="flex gap-[2px]">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="w-[2px] h-[2px] rounded-full bg-black/10" />)}</div>
              <div className="text-[9px] font-medium text-black/30 tracking-wide">iPod</div>
              <div className="flex gap-[2px]">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="w-[2px] h-[2px] rounded-full bg-black/10" />)}</div>
            </div>

            {/* Click Wheel */}
            <ClickWheel wheelRef={wheelRef} onMenu={handleMenu} onCenter={handleSel} onPrev={doPrev} onNext={doNext} onPlayPause={handlePP} />

            {/* Now playing mini indicator */}
            {npTrack && (
              <div className="mt-3 text-center">
                <div className="flex items-center justify-center gap-1.5 text-[10px] text-black/40">
                  <span>{playing ? "▶" : "❚❚"}</span>
                  <span className="truncate max-w-[180px]">{npTrack.title}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* End of iPod */}
      </div>
    </div>
  );
}
