import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { desc, eq, asc, sql } from 'drizzle-orm';
import { WebSocketServer, WebSocket } from 'ws';
import {
  normalizeSeedCode,
  type TailAccentColor,
  type WeatherPreset,
  type WingmanState,
  type WsClientMessage,
  type WsServerMessage,
} from '@patrol/shared';
import { createDatabase, pilots, postcards, seeds, sorties } from './db.js';

export interface AppOptions {
  dbPath: string;
  staticDir?: string;
}

interface WsClientMeta {
  id: string;
  ws: WebSocket;
  seedCode: string;
  state: WingmanState;
}

export function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const { db, sqlite } = createDatabase(opts.dbPath);

  // Health
  app.get('/api/health', async () => {
    return { ok: true, time: new Date().toISOString() };
  });

  // Pilot Profile
  app.get('/api/profile', async (req, reply) => {
    const tokenHeader = req.headers['x-pilot-token'];
    const tokenQuery = (req.query as { token?: string }).token;
    const token =
      (typeof tokenHeader === 'string' && tokenHeader.trim()) ||
      (typeof tokenQuery === 'string' && tokenQuery.trim()) ||
      crypto.randomUUID();

    let existing = db.select().from(pilots).where(eq(pilots.token, token)).get();
    if (!existing) {
      const now = new Date().toISOString();
      const suffix = Math.floor(100 + Math.random() * 900);
      existing = {
        id: crypto.randomUUID(),
        token,
        callsign: `PATROL-${suffix}`,
        tailColor: 'red',
        invertY: false,
        sensitivity: 1.0,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(pilots).values(existing).run();
    }
    return reply.send({ profile: existing, token });
  });

  app.post('/api/profile', async (req, reply) => {
    const body = (req.body ?? {}) as {
      token?: string;
      callsign?: string;
      tailColor?: TailAccentColor;
      invertY?: boolean;
      sensitivity?: number;
    };
    const token =
      (typeof req.headers['x-pilot-token'] === 'string' && req.headers['x-pilot-token'].trim()) ||
      (typeof body.token === 'string' && body.token.trim()) ||
      '';
    if (!token) {
      return reply.code(400).send({ error: 'Missing pilot token' });
    }

    const cleanCallsign = String(body.callsign ?? 'PATROL')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '')
      .slice(0, 12);
    if (cleanCallsign.length < 3) {
      return reply.code(400).send({ error: 'Callsign must be 3-12 characters' });
    }

    const validColors: TailAccentColor[] = ['red', 'amber', 'teal', 'violet'];
    const tailColor: TailAccentColor = validColors.includes(body.tailColor as TailAccentColor)
      ? (body.tailColor as TailAccentColor)
      : 'red';
    const invertY = Boolean(body.invertY);
    const sensitivity = Math.max(0.4, Math.min(2.0, Number(body.sensitivity ?? 1.0) || 1.0));
    const now = new Date().toISOString();

    const existing = db.select().from(pilots).where(eq(pilots.token, token)).get();
    if (!existing) {
      const row = {
        id: crypto.randomUUID(),
        token,
        callsign: cleanCallsign,
        tailColor,
        invertY,
        sensitivity,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(pilots).values(row).run();
      return reply.send({ profile: row, token });
    }

    db.update(pilots)
      .set({ callsign: cleanCallsign, tailColor, invertY, sensitivity, updatedAt: now })
      .where(eq(pilots.token, token))
      .run();
    const updated = db.select().from(pilots).where(eq(pilots.token, token)).get();
    return reply.send({ profile: updated, token });
  });

  // Seeds
  app.get('/api/seeds', async () => {
    const rows = db
      .select()
      .from(seeds)
      .orderBy(desc(seeds.upvotes), desc(seeds.createdAt))
      .limit(40)
      .all();
    return { seeds: rows };
  });

  app.post('/api/seeds', async (req, reply) => {
    const body = (req.body ?? {}) as {
      code?: string;
      name?: string;
      preset?: WeatherPreset;
      creatorCallsign?: string;
    };
    const code = normalizeSeedCode(body.code ?? '');
    const name = String(body.name ?? code).trim().slice(0, 32) || code;
    const validPresets: WeatherPreset[] = ['last-light', 'crimson-dusk', 'high-alpine'];
    const preset: WeatherPreset = validPresets.includes(body.preset as WeatherPreset)
      ? (body.preset as WeatherPreset)
      : 'last-light';
    const creatorCallsign = String(body.creatorCallsign ?? 'PATROL').trim().slice(0, 12) || 'PATROL';
    const now = new Date().toISOString();

    const existing = db.select().from(seeds).where(eq(seeds.code, code)).get();
    if (existing) {
      db.update(seeds).set({ name, preset }).where(eq(seeds.code, code)).run();
      return reply.send({ seed: db.select().from(seeds).where(eq(seeds.code, code)).get() });
    }

    const row = {
      code,
      name,
      preset,
      upvotes: 1,
      creatorCallsign,
      createdAt: now,
    };
    db.insert(seeds).values(row).run();
    return reply.code(201).send({ seed: row });
  });

  app.post('/api/seeds/:code/upvote', async (req, reply) => {
    const code = normalizeSeedCode((req.params as { code: string }).code);
    const existing = db.select().from(seeds).where(eq(seeds.code, code)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'Seed not found' });
    }
    db.update(seeds)
      .set({ upvotes: sql`${seeds.upvotes} + 1` })
      .where(eq(seeds.code, code))
      .run();
    return { seed: db.select().from(seeds).where(eq(seeds.code, code)).get() };
  });

  // Postcards
  app.get('/api/postcards', async (req) => {
    const seedCode = (req.query as { seedCode?: string }).seedCode;
    const rows = seedCode
      ? db
          .select()
          .from(postcards)
          .where(eq(postcards.seedCode, normalizeSeedCode(seedCode)))
          .orderBy(desc(postcards.createdAt))
          .limit(40)
          .all()
      : db.select().from(postcards).orderBy(desc(postcards.createdAt)).limit(40).all();
    return { postcards: rows };
  });

  app.post('/api/postcards', async (req, reply) => {
    const body = (req.body ?? {}) as {
      seedCode?: string;
      preset?: WeatherPreset;
      callsign?: string;
      imageDataUrl?: string;
      altitude?: number;
      speed?: number;
      gLoad?: number;
      heading?: number;
    };
    if (!body.imageDataUrl || !body.imageDataUrl.startsWith('data:image/png;base64,')) {
      return reply.code(400).send({ error: 'Invalid PNG postcard data' });
    }
    const row = {
      id: crypto.randomUUID(),
      seedCode: normalizeSeedCode(body.seedCode ?? 'LAKE-4821'),
      preset: body.preset ?? 'last-light',
      callsign: String(body.callsign ?? 'PATROL').slice(0, 12),
      imageDataUrl: body.imageDataUrl,
      altitude: Math.round(Number(body.altitude ?? 0)),
      speed: Math.round(Number(body.speed ?? 0)),
      gLoad: Number(Number(body.gLoad ?? 1).toFixed(1)),
      heading: Math.round(Number(body.heading ?? 0)),
      createdAt: new Date().toISOString(),
    };
    db.insert(postcards).values(row).run();
    return reply.code(201).send({ postcard: row });
  });

  // Sorties
  app.get('/api/sorties', async (req) => {
    const seedCode = normalizeSeedCode((req.query as { seedCode?: string }).seedCode ?? 'LAKE-4821');
    const rows = db
      .select()
      .from(sorties)
      .where(eq(sorties.seedCode, seedCode))
      .orderBy(asc(sorties.clearTimeMs))
      .limit(15)
      .all();
    return { sorties: rows };
  });

  app.post('/api/sorties', async (req, reply) => {
    const body = (req.body ?? {}) as {
      seedCode?: string;
      callsign?: string;
      clearTimeMs?: number;
      ringsCount?: number;
    };
    const clearTimeMs = Math.round(Number(body.clearTimeMs ?? 0));
    if (clearTimeMs <= 500) {
      return reply.code(400).send({ error: 'Invalid clear time' });
    }
    const row = {
      id: crypto.randomUUID(),
      seedCode: normalizeSeedCode(body.seedCode ?? 'LAKE-4821'),
      callsign: String(body.callsign ?? 'PATROL').slice(0, 12),
      clearTimeMs,
      ringsCount: Math.round(Number(body.ringsCount ?? 8)),
      createdAt: new Date().toISOString(),
    };
    db.insert(sorties).values(row).run();
    return reply.code(201).send({ sortie: row });
  });

  // Static client serving in production (including /s/:seedCode SPA fallback)
  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.register(fastifyStatic, {
      root: opts.staticDir,
      prefix: '/',
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // WebSocket Ambient Multiplayer ("Patrol Wing")
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, WsClientMeta>();

  function sendJson(ws: WebSocket, msg: WsServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function getRoomClients(seedCode: string): WsClientMeta[] {
    const list: WsClientMeta[] = [];
    for (const c of clients.values()) {
      if (c.seedCode === seedCode) list.push(c);
    }
    return list;
  }

  function broadcastRoomCount(seedCode: string) {
    const room = getRoomClients(seedCode);
    for (const c of room) {
      sendJson(c.ws, { type: 'room_count', seedCode, playerCount: room.length });
    }
  }

  wss.on('connection', (ws) => {
    const id = crypto.randomUUID().slice(0, 8);
    const meta: WsClientMeta = {
      id,
      ws,
      seedCode: 'LAKE-4821',
      state: {
        id,
        callsign: 'PATROL',
        tailColor: 'red',
        x: 1024,
        y: 96,
        z: 1024,
        vx: 0,
        vy: 0,
        vz: -60,
        yaw: 0,
        pitch: 0,
        roll: 0,
        throttle: 0.65,
        afterburner: false,
        updatedAt: Date.now(),
      },
    };
    clients.set(ws, meta);

    ws.on('message', (raw) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        return;
      }

      if (msg.type === 'join') {
        const oldSeed = meta.seedCode;
        const newSeed = normalizeSeedCode(msg.seedCode);
        meta.seedCode = newSeed;
        meta.state.callsign = String(msg.callsign || 'PATROL').slice(0, 12);
        meta.state.tailColor = msg.tailColor || 'red';

        if (oldSeed !== newSeed) {
          for (const c of getRoomClients(oldSeed)) {
            if (c.id !== meta.id) {
              sendJson(c.ws, { type: 'wingman_left', id: meta.id });
            }
          }
          broadcastRoomCount(oldSeed);
        }

        const room = getRoomClients(newSeed);
        const wingmen = room.filter((c) => c.id !== meta.id).map((c) => c.state);
        sendJson(ws, {
          type: 'welcome',
          id: meta.id,
          seedCode: newSeed,
          playerCount: room.length,
          wingmen,
        });
        broadcastRoomCount(newSeed);
      } else if (msg.type === 'state') {
        meta.state.x = msg.x;
        meta.state.y = msg.y;
        meta.state.z = msg.z;
        meta.state.vx = msg.vx;
        meta.state.vy = msg.vy;
        meta.state.vz = msg.vz;
        meta.state.yaw = msg.yaw;
        meta.state.pitch = msg.pitch;
        meta.state.roll = msg.roll;
        meta.state.throttle = msg.throttle;
        meta.state.afterburner = msg.afterburner;
        meta.state.updatedAt = Date.now();

        for (const c of getRoomClients(meta.seedCode)) {
          if (c.id !== meta.id) {
            sendJson(c.ws, { type: 'wingman_state', wingman: meta.state });
          }
        }
      } else if (msg.type === 'missile') {
        const missile = {
          id: crypto.randomUUID().slice(0, 8),
          ownerId: meta.id,
          x: msg.x,
          y: msg.y,
          z: msg.z,
          vx: msg.vx,
          vy: msg.vy,
          vz: msg.vz,
        };
        for (const c of getRoomClients(meta.seedCode)) {
          if (c.id !== meta.id) {
            sendJson(c.ws, { type: 'missile_fired', missile });
          }
        }
      }
    });

    ws.on('close', () => {
      const seed = meta.seedCode;
      clients.delete(ws);
      for (const c of getRoomClients(seed)) {
        sendJson(c.ws, { type: 'wingman_left', id: meta.id });
      }
      broadcastRoomCount(seed);
    });
  });

  app.server.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/ws')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  app.addHook('onClose', async () => {
    wss.close();
    sqlite.close();
  });

  return app;
}
