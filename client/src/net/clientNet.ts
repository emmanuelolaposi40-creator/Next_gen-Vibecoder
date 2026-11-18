import type {
  MissileLaunchEvent,
  PilotProfile,
  PostcardRecord,
  SeedRecord,
  SortieRecord,
  TailAccentColor,
  WeatherPreset,
  WingmanState,
  WsClientMessage,
  WsServerMessage,
} from '@patrol/shared';

const TOKEN_KEY = 'patrol_pilot_token';

export function getStoredToken(): string {
  let tok = localStorage.getItem(TOKEN_KEY);
  if (!tok) {
    tok = crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(TOKEN_KEY, tok);
  }
  return tok;
}

export async function fetchProfile(): Promise<PilotProfile> {
  const token = getStoredToken();
  const res = await fetch(`/api/profile?token=${encodeURIComponent(token)}`, {
    headers: { 'x-pilot-token': token },
  });
  if (!res.ok) throw new Error('Failed to load profile');
  const data = (await res.json()) as { profile: PilotProfile; token: string };
  localStorage.setItem(TOKEN_KEY, data.token);
  return data.profile;
}

export async function saveProfile(patch: {
  callsign: string;
  tailColor: TailAccentColor;
  invertY: boolean;
  sensitivity: number;
}): Promise<PilotProfile> {
  const token = getStoredToken();
  const res = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pilot-token': token },
    body: JSON.stringify({ ...patch, token }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to save profile');
  }
  const data = (await res.json()) as { profile: PilotProfile };
  return data.profile;
}

export async function fetchSeeds(): Promise<SeedRecord[]> {
  const res = await fetch('/api/seeds');
  if (!res.ok) return [];
  const data = (await res.json()) as { seeds: SeedRecord[] };
  return data.seeds;
}

export async function saveSeed(payload: {
  code: string;
  name: string;
  preset: WeatherPreset;
  creatorCallsign: string;
}): Promise<SeedRecord> {
  const res = await fetch('/api/seeds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to save seed');
  const data = (await res.json()) as { seed: SeedRecord };
  return data.seed;
}

export async function upvoteSeed(code: string): Promise<SeedRecord> {
  const res = await fetch(`/api/seeds/${encodeURIComponent(code)}/upvote`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to upvote seed');
  const data = (await res.json()) as { seed: SeedRecord };
  return data.seed;
}

export async function fetchPostcards(seedCode?: string): Promise<PostcardRecord[]> {
  const q = seedCode ? `?seedCode=${encodeURIComponent(seedCode)}` : '';
  const res = await fetch(`/api/postcards${q}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { postcards: PostcardRecord[] };
  return data.postcards;
}

export async function submitPostcard(payload: {
  seedCode: string;
  preset: WeatherPreset;
  callsign: string;
  imageDataUrl: string;
  altitude: number;
  speed: number;
  gLoad: number;
  heading: number;
}): Promise<PostcardRecord> {
  const res = await fetch('/api/postcards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to save postcard');
  const data = (await res.json()) as { postcard: PostcardRecord };
  return data.postcard;
}

export async function fetchSorties(seedCode: string): Promise<SortieRecord[]> {
  const res = await fetch(`/api/sorties?seedCode=${encodeURIComponent(seedCode)}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { sorties: SortieRecord[] };
  return data.sorties;
}

export async function submitSortie(payload: {
  seedCode: string;
  callsign: string;
  clearTimeMs: number;
  ringsCount: number;
}): Promise<SortieRecord> {
  const res = await fetch('/api/sorties', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to record sortie');
  const data = (await res.json()) as { sortie: SortieRecord };
  return data.sortie;
}

export class PatrolSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  public online = true;
  public connected = false;
  public playerCount = 1;
  public wingmen = new Map<string, WingmanState>();

  private seedCode = 'LAKE-4821';
  private callsign = 'PATROL';
  private tailColor: TailAccentColor = 'red';

  public onCountChange?: (count: number) => void;
  public onRemoteMissile?: (m: MissileLaunchEvent) => void;

  public connect(seedCode: string, callsign: string, tailColor: TailAccentColor): void {
    this.seedCode = seedCode;
    this.callsign = callsign;
    this.tailColor = tailColor;
    if (!this.online) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.sendJoin();
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.sendJoin();
    };

    ws.onmessage = (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.playerCount = msg.playerCount;
        this.wingmen.clear();
        for (const w of msg.wingmen) this.wingmen.set(w.id, w);
        this.onCountChange?.(this.playerCount);
      } else if (msg.type === 'room_count') {
        this.playerCount = msg.playerCount;
        this.onCountChange?.(this.playerCount);
      } else if (msg.type === 'wingman_state') {
        this.wingmen.set(msg.wingman.id, msg.wingman);
      } else if (msg.type === 'wingman_left') {
        this.wingmen.delete(msg.id);
      } else if (msg.type === 'missile_fired') {
        this.onRemoteMissile?.(msg.missile);
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.wingmen.clear();
      if (this.online) {
        this.reconnectTimer = window.setTimeout(() => {
          this.connect(this.seedCode, this.callsign, this.tailColor);
        }, 2500);
      }
    };
  }

  public setOnline(enabled: boolean): void {
    this.online = enabled;
    if (!enabled) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.ws?.close();
      this.ws = null;
      this.connected = false;
      this.wingmen.clear();
      this.playerCount = 1;
      this.onCountChange?.(1);
    } else {
      this.connect(this.seedCode, this.callsign, this.tailColor);
    }
  }

  public sendJoin(): void {
    this.send({
      type: 'join',
      seedCode: this.seedCode,
      callsign: this.callsign,
      tailColor: this.tailColor,
    });
  }

  public updateIdentity(seedCode: string, callsign: string, tailColor: TailAccentColor): void {
    this.seedCode = seedCode;
    this.callsign = callsign;
    this.tailColor = tailColor;
    if (this.online) this.sendJoin();
  }

  public sendState(msg: Omit<Extract<WsClientMessage, { type: 'state' }>, 'type'>): void {
    if (!this.online) return;
    this.send({ type: 'state', ...msg });
  }

  public sendMissile(msg: Omit<Extract<WsClientMessage, { type: 'missile' }>, 'type'>): void {
    if (!this.online) return;
    this.send({ type: 'missile', ...msg });
  }

  private send(msg: WsClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
