import type { MusicConfig, MusicTrack, ServerMsg } from "../protocol";
import type { RibbonSocket } from "../ws";

/**
 * Spotify 재생 화면. 관리자 설정의 '재생할 곳'(TV 화면 / 관리자 페이지)인 화면에서만 켜져서
 * Web Playback SDK 로 이 브라우저를 Spotify 스피커("리본 TV" 등)로 만든다. 무엇을 틀지는 서버가 Web API 로 정한다
 * (리본이에게 한 말 -> server/ribbon/music_intent.py). Premium 계정만 된다.
 *
 * - 장치 id 를 서버에 알린다 (music.device). 재생 상태가 바뀌면 알린다 (music.state -> TV 아래 상태바)
 * - 리본이가 말하거나 마이크가 아이 말을 받는 동안은 소리를 줄인다 (음악이 마이크로 들어가지 않게)
 * - 브라우저 자동 재생 막기: 화면을 한 번 누르거나 키를 누르면 풀린다 (activateElement)
 */

interface SdkTrack { uri: string; name: string; duration_ms: number; artists: { name: string }[]; album: { images: { url: string }[] } }
interface SdkState {
  paused: boolean;
  position: number;
  /** 0 = 안 함, 1 = 목록 반복, 2 = 한 곡 반복 */
  repeat_mode: number;
  shuffle: boolean;
  context: { uri: string | null };
  track_window: { current_track: SdkTrack | null };
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  setVolume(v: number): Promise<void>;
  activateElement(): Promise<void>;
  addListener(ev: "ready" | "not_ready", cb: (d: { device_id: string }) => void): void;
  addListener(ev: "player_state_changed", cb: (s: SdkState | null) => void): void;
  addListener(ev: "initialization_error" | "authentication_error" | "account_error" | "playback_error", cb: (e: { message: string }) => void): void;
}
interface SpotifyNs { Player: new (o: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume: number }) => SdkPlayer }

let sdk: Promise<SpotifyNs> | null = null;
function loadSdk(): Promise<SpotifyNs> {
  sdk ??= new Promise((resolve, reject) => {
    const w = window as unknown as { onSpotifyWebPlaybackSDKReady?: () => void; Spotify?: SpotifyNs };
    w.onSpotifyWebPlaybackSDKReady = () => resolve(w.Spotify!);
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.onerror = () => { sdk = null; reject(new Error("Spotify 재생 모듈을 받지 못했습니다 (인터넷 확인)")); };
    document.head.appendChild(s);
  });
  return sdk;
}

/** 서버가 넘긴 곡 정보와 같은 모양 (server music.track_info) */
function toTrack(t: SdkTrack | null): MusicTrack | null {
  if (!t) return null;
  return { uri: t.uri, title: t.name, artists: t.artists.map((a) => a.name).join(", "),
    album_art: t.album.images[0]?.url ?? "", duration_ms: t.duration_ms };
}

const DUCK = 0.2;          // 리본이가 말하거나 아이 말을 받는 동안 음량 배율

export class MusicPlayer {
  private player: SdkPlayer | null = null;
  private starting = false;
  private volume = 0.6;
  private ducked = false;
  private speaking = false;
  private micOn = false;
  private lastKey = "";

  constructor(private socket: RibbonSocket, private role: "tv" | "admin", private name: string) {
    socket.on((m: ServerMsg) => {
      if (m.type === "state") this.apply(m.config?.music);
      else if (m.type === "ribbon.state") { this.speaking = m.state === "speaking"; this.duck(); }
      else if (m.type === "mic") { this.micOn = m.on; this.duck(); }
      else if (m.type === "speak.stop") { this.speaking = false; this.duck(); }
    });
    // 자동 재생 막기 풀기: 사용자가 화면을 한 번 건드리면
    const unlock = () => { void this.player?.activateElement(); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, unlock, { passive: true });
  }

  /** 서버 설정이 올 때마다: 이 화면이 재생할 곳이면 켜고, 아니면 끈다 */
  apply(cfg?: MusicConfig): void {
    if (!cfg) return;
    this.volume = Math.max(0, Math.min(1, (cfg.volume ?? 60) / 100));
    const want = cfg.enabled && cfg.output === this.role;
    if (want && !this.player) void this.start();
    else if (!want && this.player) this.stop();
    else this.duck();
  }

  private async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      const Spotify = await loadSdk();
      const p = new Spotify.Player({
        name: this.name,
        volume: this.target(),
        getOAuthToken: (cb) => {
          fetch("/api/music/token").then((r) => r.json()).then((j) => {
            if (j.access_token) cb(j.access_token); else this.log(`토큰을 받지 못했습니다: ${j.detail ?? ""}`);
          }).catch((e) => this.log(`토큰을 받지 못했습니다: ${e}`));
        },
      });
      p.addListener("ready", ({ device_id }) => this.socket.sendJson({ type: "music.device", device_id }));
      p.addListener("not_ready", () => this.socket.sendJson({ type: "music.device", device_id: "" }));
      p.addListener("player_state_changed", (s) => this.report(s));
      p.addListener("initialization_error", (e) => this.log(`시작 실패 (이 브라우저가 지원하지 않음): ${e.message}`));
      p.addListener("authentication_error", (e) => this.log(`로그인 문제: ${e.message}`));
      p.addListener("account_error", (e) => this.log(`Premium 계정이어야 합니다: ${e.message}`));
      p.addListener("playback_error", (e) => this.log(`재생 실패: ${e.message}`));
      this.player = p;
      if (!(await p.connect())) this.log("Spotify 스피커 연결 실패");
    } catch (e) {
      this.log(String(e));
    } finally {
      this.starting = false;
    }
  }

  private stop(): void {
    this.player?.disconnect();
    this.player = null;
    this.lastKey = "";
    this.socket.sendJson({ type: "music.device", device_id: "" });
  }

  private report(s: SdkState | null): void {
    const track = toTrack(s?.track_window.current_track ?? null);
    const playing = !!s && !s.paused && !!track;
    const position_ms = s?.position ?? 0;
    const repeat = ["off", "context", "track"][s?.repeat_mode ?? 0] ?? "off";
    const shuffle = !!s?.shuffle;
    const context_uri = s?.context.uri ?? "";
    // 같은 곡·같은 상태면 위치만 조금 바뀐 것: 자주 보내지 않는다 (상태바가 스스로 흘려 보인다)
    const key = `${track?.uri}|${playing}|${repeat}|${shuffle}|${Math.round(position_ms / 5000)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.socket.sendJson({ type: "music.state", playing, track, position_ms, repeat, shuffle, context_uri });
  }

  private target(): number {
    return this.volume * (this.ducked ? DUCK : 1);
  }

  private duck(): void {
    this.ducked = this.speaking || this.micOn;
    void this.player?.setVolume(this.target()).catch(() => undefined);
  }

  private log(text: string): void {
    console.warn("[music]", text);
    this.socket.sendJson({ type: "client.log", text: `Spotify: ${text}` });
  }
}
