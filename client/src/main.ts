import './style.css';
import {
  WEATHER_PRESETS,
  WORLD_SIZE,
  generateSortieRings,
  normalizeSeedCode,
  type PilotProfile,
  type RingTarget,
  type WeatherPreset,
} from '@patrol/shared';
import { SoundEngine } from './audio/soundEngine.js';
import { CockpitHud } from './hud/cockpitHud.js';
import {
  PatrolSocket,
  fetchProfile,
  submitPostcard,
  submitSortie,
} from './net/clientNet.js';
import { PatrolRenderer } from './render/renderer.js';
import { FlightSim } from './sim/flightSim.js';
import { generateTerrainInWorker, type TerrainMapData } from './terrain/terrainLoader.js';
import { renderModalTab, type ModalContext, type ModalTab } from './ui/modals.js';

// Parse URL permalink /s/:seedCode?preset=...
function parseInitialRoute(): { seed: string; preset: WeatherPreset } {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9-]+)/);
  const seed = m ? normalizeSeedCode(decodeURIComponent(m[1])) : 'LAKE-4821';
  const params = new URLSearchParams(location.search);
  const p = params.get('preset') as WeatherPreset | null;
  const preset: WeatherPreset = p && p in WEATHER_PRESETS ? p : 'last-light';
  return { seed, preset };
}

async function boot() {
  const glCanvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
  const hudCanvas = document.getElementById('hud-canvas') as HTMLCanvasElement;
  const loaderOverlay = document.getElementById('loader-overlay') as HTMLElement;
  const loaderSeed = document.getElementById('loader-seed') as HTMLElement;
  const loaderBar = document.getElementById('loader-bar') as HTMLElement;
  const loaderStatus = document.getElementById('loader-status') as HTMLElement;
  const titleOverlay = document.getElementById('title-overlay') as HTMLElement;
  const titleMeta = document.getElementById('title-meta') as HTMLElement;
  const modalOverlay = document.getElementById('modal-overlay') as HTMLElement;
  const modalBody = document.getElementById('modal-body') as HTMLElement;
  const toastEl = document.getElementById('toast') as HTMLElement;

  const badgeSeed = document.getElementById('badge-seed') as HTMLElement;
  const badgePlayers = document.getElementById('badge-players') as HTMLElement;
  const netDot = document.getElementById('net-dot') as HTMLElement;
  const camLabel = document.getElementById('camera-label') as HTMLElement;
  const missilePips = Array.from(document.querySelectorAll('#missile-pips .pip'));
  const sortieHud = document.getElementById('btn-sortie-hud') as HTMLElement;
  const sortieHudText = document.getElementById('sortie-hud-text') as HTMLElement;

  const renderer = new PatrolRenderer(glCanvas);
  const hud = new CockpitHud(hudCanvas);
  const sim = new FlightSim();
  const sound = new SoundEngine();
  const net = new PatrolSocket();

  let { seed: currentSeed, preset: currentPreset } = parseInitialRoute();
  let terrain: TerrainMapData | null = null;
  let profile: PilotProfile = {
    id: 'local',
    callsign: 'PATROL-1',
    tailColor: 'red',
    invertY: false,
    sensitivity: 1.0,
    createdAt: '',
    updatedAt: '',
  };

  // Sortie state
  let sortieActive = false;
  let sortieRings: RingTarget[] = [];
  let sortieIndex = 0;
  let sortieStartMs = 0;

  let toastTimer: number | null = null;
  function showToast(msg: string) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), 2600);
  }

  function updateBadges() {
    badgeSeed.textContent = currentSeed;
    const wingTxt = net.online ? `${net.playerCount} IN WING` : 'SOLO';
    badgePlayers.textContent = wingTxt;
    netDot.className = `dot ${net.online && net.connected ? 'online' : 'offline'}`;
    titleMeta.textContent = `SEED: ${currentSeed} · ${WEATHER_PRESETS[currentPreset].label.toUpperCase()} · ${wingTxt}`;
  }

  async function loadSector(seedCode: string, preset: WeatherPreset) {
    currentSeed = normalizeSeedCode(seedCode);
    currentPreset = preset;
    loaderSeed.textContent = `SEED: ${currentSeed} · ${WEATHER_PRESETS[currentPreset].label.toUpperCase()}`;
    loaderBar.style.width = '0%';
    loaderStatus.textContent = '0% — INITIALIZING WORKER';
    loaderOverlay.classList.remove('hidden');

    terrain = await generateTerrainInWorker(currentSeed, currentPreset, (pct, stage) => {
      loaderBar.style.width = `${pct}%`;
      loaderStatus.textContent = `${pct}% — ${stage}`;
    });
    renderer.uploadTerrain(terrain);
    sim.resetPosition();
    loaderOverlay.classList.add('hidden');

    if (sortieActive) {
      startSortie();
    }
    net.updateIdentity(currentSeed, profile.callsign, profile.tailColor);
    updateBadges();

    // Update browser URL cleanly
    const targetPath = `/s/${encodeURIComponent(currentSeed)}?preset=${encodeURIComponent(currentPreset)}`;
    if (location.pathname + location.search !== targetPath) {
      history.replaceState(null, '', targetPath);
    }
  }

  function startSortie() {
    sortieRings = generateSortieRings(currentSeed, 8);
    sortieIndex = 0;
    sortieStartMs = performance.now();
    sortieHud.classList.remove('hidden');
  }

  function stopSortie() {
    sortieRings = [];
    sortieHud.classList.add('hidden');
  }

  // Load profile from backend
  try {
    profile = await fetchProfile();
    sim.tailColor = profile.tailColor;
  } catch {
    // Offline fallback
  }

  net.onCountChange = () => updateBadges();
  net.onRemoteMissile = (m) => {
    sim.fireMissile(true, m);
  };
  sim.onMissileImpact = (isWater, dist) => {
    sound.playDetonation(isWater, dist);
  };

  net.connect(currentSeed, profile.callsign, profile.tailColor);
  await loadSector(currentSeed, currentPreset);

  // Input state
  const input = {
    cursorX: 0,
    cursorY: 0,
    hasMouseMoved: false,
    afterburner: false,
    invertY: profile.invertY,
    sensitivity: profile.sensitivity,
  };

  let leftMouseDown = false;
  let leftDownAt = 0;
  let activeModalTab: ModalTab = 'seeds';

  function isUiBlocked(): boolean {
    return !modalOverlay.classList.contains('hidden');
  }

  function firePlayerMissile() {
    if (sim.fireMissile(false)) {
      sound.playMissileWhoosh();
      const cp = Math.cos(sim.pitch);
      const mSpeed = sim.speed + 125;
      net.sendMissile({
        x: sim.x,
        y: sim.y - 0.3,
        z: sim.z,
        vx: -Math.sin(sim.yaw) * cp * mSpeed,
        vy: (Math.sin(sim.pitch) + (sim.pitch > -0.06 ? -0.14 : 0)) * mSpeed,
        vz: -Math.cos(sim.yaw) * cp * mSpeed,
      });
    }
  }

  async function snapPostcard() {
    const dataUrl = renderer.capturePostcardDataUrl();
    const hdg = Math.round((((-sim.yaw * 180) / Math.PI) % 360 + 360) % 360);
    const altFt = Math.round(sim.y * 32);
    const speedKts = Math.round(sim.speed * 4.8);
    try {
      await submitPostcard({
        seedCode: currentSeed,
        preset: currentPreset,
        callsign: profile.callsign,
        imageDataUrl: dataUrl,
        altitude: altFt,
        speed: speedKts,
        gLoad: sim.gLoad,
        heading: hdg,
      });
      sound.playClick();
      showToast('POSTCARD PINNED TO RECON WALL');
    } catch {
      showToast('POSTCARD CAPTURED (OFFLINE)');
    }
  }

  function openModal(tab: ModalTab) {
    activeModalTab = tab;
    titleOverlay.classList.add('hidden');
    modalOverlay.classList.remove('hidden');
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    const ctx: ModalContext = {
      currentSeed,
      currentPreset,
      sortieActive,
      profile,
      onSelectSeed: async (seed, preset) => {
        modalOverlay.classList.add('hidden');
        await loadSector(seed, preset);
        showToast(`DEPLOYED: ${seed}`);
      },
      onToggleSortie: (enabled) => {
        sortieActive = enabled;
        if (enabled) startSortie();
        else stopSortie();
      },
      onSnapPostcard: snapPostcard,
      onProfileUpdated: (updated) => {
        profile = updated;
        sim.tailColor = updated.tailColor;
        input.invertY = updated.invertY;
        input.sensitivity = updated.sensitivity;
        net.updateIdentity(currentSeed, updated.callsign, updated.tailColor);
      },
      onToast: showToast,
    };
    void renderModalTab(tab, modalBody, ctx);
  }

  // Mouse & Keyboard Listeners
  window.addEventListener('mousemove', (e) => {
    if (isUiBlocked() || !titleOverlay.classList.contains('hidden')) return;
    input.hasMouseMoved = true;
    input.cursorX = (e.clientX / window.innerWidth) * 2 - 1;
    input.cursorY = (e.clientY / window.innerHeight) * 2 - 1;
  });

  glCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  glCanvas.addEventListener('mousedown', (e) => {
    if (isUiBlocked()) return;
    if (!titleOverlay.classList.contains('hidden')) {
      titleOverlay.classList.add('hidden');
    }
    if (e.button === 0) {
      leftMouseDown = true;
      leftDownAt = performance.now();
      input.afterburner = true;
    } else if (e.button === 2) {
      firePlayerMissile();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 0 && leftMouseDown) {
      leftMouseDown = false;
      input.afterburner = false;
      if (performance.now() - leftDownAt < 230 && !isUiBlocked()) {
        sim.triggerBarrelRoll();
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!modalOverlay.classList.contains('hidden')) {
        modalOverlay.classList.add('hidden');
      }
      return;
    }
    if (isUiBlocked()) return;

    if (e.code === 'Space') {
      e.preventDefault();
      const mode = sim.cycleCamera();
      camLabel.textContent = mode.toUpperCase();
      sound.playClick();
    } else if (e.key === 'f' || e.key === 'F') {
      firePlayerMissile();
    } else if (e.key === 'p' || e.key === 'P') {
      void snapPostcard();
    }
  });

  // UI Buttons
  document.getElementById('btn-launch')?.addEventListener('click', () => {
    titleOverlay.classList.add('hidden');
    sound.playClick();
  });
  document.getElementById('btn-title-seeds')?.addEventListener('click', () => openModal('seeds'));
  document.getElementById('btn-seed-badge')?.addEventListener('click', () => openModal('seeds'));
  document.getElementById('btn-wall')?.addEventListener('click', () => openModal('wall'));
  document.getElementById('btn-pilot')?.addEventListener('click', () => openModal('pilot'));
  document.getElementById('btn-close-modal')?.addEventListener('click', () =>
    modalOverlay.classList.add('hidden')
  );

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab') as ModalTab;
      if (tab !== activeModalTab || modalOverlay.classList.contains('hidden')) {
        openModal(tab);
      }
    });
  });

  const btnOffline = document.getElementById('btn-offline') as HTMLButtonElement;
  btnOffline.addEventListener('click', () => {
    net.setOnline(!net.online);
    btnOffline.textContent = net.online ? 'ONLINE' : 'SOLO';
    updateBadges();
    sound.playClick();
  });

  const btnSound = document.getElementById('btn-sound') as HTMLButtonElement;
  btnSound.addEventListener('click', () => {
    const on = sound.toggle();
    btnSound.textContent = on ? 'AUDIO: ON' : 'AUDIO: OFF';
  });

  // Touch Controls
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouch) {
    document.getElementById('touch-controls')?.classList.remove('hidden');
    const stickZone = document.getElementById('touch-stick-zone')!;
    const stickNub = document.getElementById('touch-stick-nub')!;

    stickZone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      const rect = stickZone.getBoundingClientRect();
      const nx = Math.max(-1, Math.min(1, ((t.clientX - rect.left) / rect.width) * 2 - 1));
      const ny = Math.max(-1, Math.min(1, ((t.clientY - rect.top) / rect.height) * 2 - 1));
      input.hasMouseMoved = true;
      input.cursorX = nx;
      input.cursorY = ny;
      stickNub.style.transform = `translate(${nx * 36}px, ${ny * 36}px)`;
    });
    stickZone.addEventListener('touchend', () => {
      input.cursorX = 0;
      input.cursorY = 0;
      stickNub.style.transform = 'translate(0, 0)';
    });

    document.getElementById('touch-cam')?.addEventListener('click', () => {
      const mode = sim.cycleCamera();
      camLabel.textContent = mode.toUpperCase();
    });
    document.getElementById('touch-roll')?.addEventListener('click', () => sim.triggerBarrelRoll());
    const tb = document.getElementById('touch-burner')!;
    tb.addEventListener('touchstart', () => (input.afterburner = true));
    tb.addEventListener('touchend', () => (input.afterburner = false));
    document.getElementById('touch-fire')?.addEventListener('click', () => firePlayerMissile());
  }

  // Main Animation Loop
  let lastTs = performance.now();
  let netTimer = 0;
  let elapsed = 0;

  function frame(ts: number) {
    const dtMs = Math.min(50, Math.max(1, ts - lastTs));
    const dt = dtMs / 1000;
    lastTs = ts;
    elapsed += dt;

    renderer.updateResolution(dtMs);
    sim.step(dt, input, terrain);
    sound.updateFlight(sim.speed, sim.afterburner);

    // Check Sortie Ring Collision
    if (sortieActive && sortieIndex < sortieRings.length) {
      const target = sortieRings[sortieIndex];
      const dx = sim.x - target.x;
      const dy = sim.y - target.y;
      const dz = sim.z - target.z;
      if (Math.hypot(dx, dy, dz) < target.radius + 5) {
        sortieIndex++;
        sound.playClick();
        if (sortieIndex >= sortieRings.length) {
          const clearMs = Math.round(performance.now() - sortieStartMs);
          showToast(`SORTIE CLEARED IN ${(clearMs / 1000).toFixed(2)}s!`);
          void submitSortie({
            seedCode: currentSeed,
            callsign: profile.callsign,
            clearTimeMs: clearMs,
            ringsCount: sortieRings.length,
          });
          startSortie();
        }
      }
      if (sortieIndex < sortieRings.length) {
        const sec = ((performance.now() - sortieStartMs) / 1000).toFixed(1);
        sortieHudText.textContent = `RING ${sortieIndex + 1}/${sortieRings.length} · ${sec}s`;
      }
    }

    // Broadcast flight state over WebSocket at ~20Hz
    netTimer += dt;
    if (netTimer >= 0.05) {
      netTimer = 0;
      const cp = Math.cos(sim.pitch);
      net.sendState({
        x: sim.x,
        y: sim.y,
        z: sim.z,
        vx: -Math.sin(sim.yaw) * cp * sim.speed,
        vy: Math.sin(sim.pitch) * sim.speed,
        vz: -Math.cos(sim.yaw) * cp * sim.speed,
        yaw: sim.yaw,
        pitch: sim.pitch,
        roll: sim.roll,
        throttle: sim.throttle,
        afterburner: sim.afterburner,
      });
    }

    // Update missile pips
    for (let i = 0; i < 4; i++) {
      missilePips[i]?.classList.toggle('empty', sim.railCooldowns[i] > 0);
    }

    const cam = sim.getCamera();
    const wingmenArr = Array.from(net.wingmen.values());

    // Wrap wingmen around toroidal world for seamless rendering near player
    const wrappedWingmen = wingmenArr.map((w) => {
      let wx = w.x;
      let wz = w.z;
      if (wx - sim.x > WORLD_SIZE / 2) wx -= WORLD_SIZE;
      if (wx - sim.x < -WORLD_SIZE / 2) wx += WORLD_SIZE;
      if (wz - sim.z > WORLD_SIZE / 2) wz -= WORLD_SIZE;
      if (wz - sim.z < -WORLD_SIZE / 2) wz += WORLD_SIZE;
      return {
        x: wx,
        y: w.y,
        z: wz,
        yaw: w.yaw,
        pitch: w.pitch,
        roll: w.roll,
        tailColor: w.tailColor,
        afterburner: w.afterburner,
      };
    });

    renderer.render({
      time: elapsed,
      preset: currentPreset,
      camPos: cam.pos,
      camTarget: cam.target,
      camUp: cam.up,
      fovRad: cam.fov,
      showPlayerJet: sim.cameraMode !== 'cockpit',
      playerJet: {
        x: sim.x,
        y: sim.y,
        z: sim.z,
        yaw: sim.yaw,
        pitch: sim.pitch,
        roll: sim.roll,
        tailColor: sim.tailColor,
        afterburner: sim.afterburner,
        railReady: [
          sim.railCooldowns[0] <= 0,
          sim.railCooldowns[1] <= 0,
          sim.railCooldowns[2] <= 0,
          sim.railCooldowns[3] <= 0,
        ],
      },
      wingmen: wrappedWingmen,
      missiles: sim.missiles,
      particles: sim.particles,
      rings: sortieRings.map((r, i) => ({
        ...r,
        active: i === sortieIndex,
      })),
      impacts: sim.impacts,
    });

    const activeRing = sortieActive && sortieIndex < sortieRings.length ? sortieRings[sortieIndex] : null;
    hud.render(
      dt,
      renderer.internalWidth,
      renderer.internalHeight,
      sim,
      terrain,
      wingmenArr,
      activeRing
    );

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error('Patrol boot error:', err);
});
