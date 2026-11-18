export type WeatherPreset = 'last-light' | 'crimson-dusk' | 'high-alpine';

export type CameraMode = 'topdown' | 'chase' | 'cockpit';

export type TailAccentColor = 'red' | 'amber' | 'teal' | 'violet';

export interface WeatherPresetConfig {
  id: WeatherPreset;
  label: string;
  description: string;
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  cloudDensity: number;
  snowLine: number;
  hazeWarmRgb: [number, number, number];
  hazeCoolRgb: [number, number, number];
  skyZenithRgb: [number, number, number];
  skyHorizonRgb: [number, number, number];
  sunDiscRgb: [number, number, number];
}

export interface PilotProfile {
  id: string;
  callsign: string;
  tailColor: TailAccentColor;
  invertY: boolean;
  sensitivity: number;
  createdAt: string;
  updatedAt: string;
}

export interface SeedRecord {
  code: string;
  name: string;
  preset: WeatherPreset;
  upvotes: number;
  creatorCallsign: string;
  createdAt: string;
}

export interface PostcardRecord {
  id: string;
  seedCode: string;
  preset: WeatherPreset;
  callsign: string;
  imageDataUrl: string;
  altitude: number;
  speed: number;
  gLoad: number;
  heading: number;
  createdAt: string;
}

export interface SortieRecord {
  id: string;
  seedCode: string;
  callsign: string;
  clearTimeMs: number;
  ringsCount: number;
  createdAt: string;
}

export interface RingTarget {
  index: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  radius: number;
}

export interface WingmanState {
  id: string;
  callsign: string;
  tailColor: TailAccentColor;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  roll: number;
  throttle: number;
  afterburner: boolean;
  updatedAt: number;
}

export interface MissileLaunchEvent {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export type WsClientMessage =
  | {
      type: 'join';
      seedCode: string;
      callsign: string;
      tailColor: TailAccentColor;
    }
  | {
      type: 'state';
      x: number;
      y: number;
      z: number;
      vx: number;
      vy: number;
      vz: number;
      yaw: number;
      pitch: number;
      roll: number;
      throttle: number;
      afterburner: boolean;
    }
  | {
      type: 'missile';
      x: number;
      y: number;
      z: number;
      vx: number;
      vy: number;
      vz: number;
    }
  | {
      type: 'leave';
    };

export type WsServerMessage =
  | {
      type: 'welcome';
      id: string;
      seedCode: string;
      playerCount: number;
      wingmen: WingmanState[];
    }
  | {
      type: 'room_count';
      seedCode: string;
      playerCount: number;
    }
  | {
      type: 'wingman_state';
      wingman: WingmanState;
    }
  | {
      type: 'wingman_left';
      id: string;
    }
  | {
      type: 'missile_fired';
      missile: MissileLaunchEvent;
    };
