import {
  TAIL_ACCENT_COLORS,
  WEATHER_PRESETS,
  generateSeedCode,
  normalizeSeedCode,
  type PilotProfile,
  type PostcardRecord,
  type SeedRecord,
  type SortieRecord,
  type TailAccentColor,
  type WeatherPreset,
} from '@patrol/shared';
import {
  fetchPostcards,
  fetchSeeds,
  fetchSorties,
  saveProfile,
  saveSeed,
  upvoteSeed,
} from '../net/clientNet.js';

export type ModalTab = 'seeds' | 'wall' | 'pilot';

export interface ModalContext {
  currentSeed: string;
  currentPreset: WeatherPreset;
  sortieActive: boolean;
  profile: PilotProfile;
  onSelectSeed: (seedCode: string, preset: WeatherPreset) => void;
  onToggleSortie: (enabled: boolean) => void;
  onSnapPostcard: () => Promise<void>;
  onProfileUpdated: (profile: PilotProfile) => void;
  onToast: (msg: string) => void;
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function renderModalTab(
  tab: ModalTab,
  container: HTMLElement,
  ctx: ModalContext
): Promise<void> {
  if (tab === 'seeds') {
    container.innerHTML = `<div class="mono-dim">LOADING SEEDS &amp; SORTIES...</div>`;
    const [seedList, sortieList] = await Promise.all([
      fetchSeeds(),
      fetchSorties(ctx.currentSeed),
    ]);

    const presetOptions = (Object.keys(WEATHER_PRESETS) as WeatherPreset[])
      .map(
        (id) =>
          `<option value="${id}" ${id === ctx.currentPreset ? 'selected' : ''}>${esc(
            WEATHER_PRESETS[id].label
          )}</option>`
      )
      .join('');

    const seedCards = seedList
      .map(
        (s: SeedRecord) => `
      <div class="seed-card">
        <div class="row-between">
          <strong>${esc(s.name)}</strong>
          <span class="mono-dim">${esc(s.code)}</span>
        </div>
        <div class="mono-dim">${esc(WEATHER_PRESETS[s.preset]?.label ?? s.preset)} · BY ${esc(
          s.creatorCallsign
        )}</div>
        <div class="row-between">
          <button class="pixel-btn small" data-fly-seed="${esc(s.code)}" data-fly-preset="${esc(
            s.preset
          )}">FLY</button>
          <button class="pixel-btn small" data-upvote-seed="${esc(s.code)}">▲ ${s.upvotes}</button>
        </div>
      </div>`
      )
      .join('');

    const sortieRows =
      sortieList.length === 0
        ? `<div class="mono-dim">No recorded sorties on ${esc(ctx.currentSeed)} yet.</div>`
        : sortieList
            .map(
              (r: SortieRecord, i: number) => `
        <div class="row-between mono-dim" style="padding: 3px 0; border-bottom: 1px solid #2b2242;">
          <span>#${i + 1} ${esc(r.callsign)}</span>
          <span>${(r.clearTimeMs / 1000).toFixed(2)}s (${r.ringsCount} RINGS)</span>
        </div>`
            )
            .join('');

    container.innerHTML = `
      <div class="modal-section">
        <h3>ACTIVE SECTOR &amp; PRESET</h3>
        <div class="form-row">
          <input id="inp-seed-code" class="pixel-input" value="${esc(ctx.currentSeed)}" maxlength="16" style="width:140px" />
          <select id="sel-preset" class="pixel-select">${presetOptions}</select>
          <button id="btn-roll-seed" class="pixel-btn small">ROLL</button>
          <button id="btn-go-seed" class="pixel-btn small primary">DEPLOY</button>
          <button id="btn-copy-link" class="pixel-btn small">SHARE URL</button>
        </div>
        <div class="form-row">
          <input id="inp-seed-name" class="pixel-input" placeholder="Name this sector..." maxlength="32" style="width:180px" />
          <button id="btn-save-seed" class="pixel-btn small">SAVE TO DB</button>
          <button id="btn-toggle-sortie" class="pixel-btn small ${ctx.sortieActive ? 'primary' : ''}">
            SORTIE MODE: ${ctx.sortieActive ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div class="modal-section">
        <h3>COMMUNITY SEEDS</h3>
        <div class="card-grid">${seedCards || '<div class="mono-dim">No saved seeds.</div>'}</div>
      </div>

      <div class="modal-section">
        <h3>RECON SORTIE LEADERBOARD (${esc(ctx.currentSeed)})</h3>
        ${sortieRows}
      </div>
    `;

    container.querySelector('#btn-roll-seed')?.addEventListener('click', () => {
      const inp = container.querySelector('#inp-seed-code') as HTMLInputElement;
      inp.value = generateSeedCode();
    });

    container.querySelector('#btn-go-seed')?.addEventListener('click', () => {
      const code = normalizeSeedCode((container.querySelector('#inp-seed-code') as HTMLInputElement).value);
      const preset = (container.querySelector('#sel-preset') as HTMLSelectElement).value as WeatherPreset;
      ctx.onSelectSeed(code, preset);
    });

    container.querySelector('#btn-copy-link')?.addEventListener('click', async () => {
      const code = normalizeSeedCode((container.querySelector('#inp-seed-code') as HTMLInputElement).value);
      const preset = (container.querySelector('#sel-preset') as HTMLSelectElement).value as WeatherPreset;
      const url = `${location.origin}/s/${encodeURIComponent(code)}?preset=${encodeURIComponent(preset)}`;
      try {
        await navigator.clipboard.writeText(url);
        ctx.onToast(`COPIED ${url}`);
      } catch {
        ctx.onToast(`/s/${code}?preset=${preset}`);
      }
    });

    container.querySelector('#btn-save-seed')?.addEventListener('click', async () => {
      const code = normalizeSeedCode((container.querySelector('#inp-seed-code') as HTMLInputElement).value);
      const name = (container.querySelector('#inp-seed-name') as HTMLInputElement).value.trim() || code;
      const preset = (container.querySelector('#sel-preset') as HTMLSelectElement).value as WeatherPreset;
      await saveSeed({ code, name, preset, creatorCallsign: ctx.profile.callsign });
      ctx.onToast(`SAVED ${name}`);
      void renderModalTab('seeds', container, ctx);
    });

    container.querySelector('#btn-toggle-sortie')?.addEventListener('click', () => {
      ctx.onToggleSortie(!ctx.sortieActive);
      void renderModalTab('seeds', container, ctx);
    });

    container.querySelectorAll('[data-fly-seed]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-fly-seed')!;
        const preset = btn.getAttribute('data-fly-preset') as WeatherPreset;
        ctx.onSelectSeed(code, preset);
      });
    });

    container.querySelectorAll('[data-upvote-seed]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const code = btn.getAttribute('data-upvote-seed')!;
        await upvoteSeed(code);
        void renderModalTab('seeds', container, ctx);
      });
    });
  } else if (tab === 'wall') {
    container.innerHTML = `<div class="mono-dim">LOADING RECON POSTCARDS...</div>`;
    const list = await fetchPostcards();
    const cards = list
      .map(
        (p: PostcardRecord) => `
      <div class="postcard-card">
        <img src="${esc(p.imageDataUrl)}" alt="Postcard by ${esc(p.callsign)}" />
        <div class="row-between">
          <strong>${esc(p.callsign)}</strong>
          <span class="mono-dim">${esc(p.seedCode)}</span>
        </div>
        <div class="mono-dim">${p.altitude}FT · ${p.speed}KTS · ${p.gLoad.toFixed(1)}G · HDG ${String(
          p.heading
        ).padStart(3, '0')}</div>
      </div>`
      )
      .join('');

    container.innerHTML = `
      <div class="modal-section">
        <div class="row-between">
          <h3>RECON POSTCARD WALL</h3>
          <button id="btn-snap-now" class="pixel-btn small primary">SNAP POSTCARD [P]</button>
        </div>
      </div>
      <div class="card-grid">
        ${cards || '<div class="mono-dim">No postcards pinned yet. Press [P] in flight!</div>'}
      </div>
    `;

    container.querySelector('#btn-snap-now')?.addEventListener('click', async () => {
      await ctx.onSnapPostcard();
      void renderModalTab('wall', container, ctx);
    });
  } else if (tab === 'pilot') {
    const colorOptions = (Object.keys(TAIL_ACCENT_COLORS) as TailAccentColor[])
      .map(
        (c) =>
          `<option value="${c}" ${c === ctx.profile.tailColor ? 'selected' : ''}>${
            TAIL_ACCENT_COLORS[c].label
          }</option>`
      )
      .join('');

    container.innerHTML = `
      <div class="modal-section">
        <h3>PILOT PROFILE &amp; CONTROLS</h3>
        <div class="form-row">
          <label class="mono-dim" style="width:120px">CALLSIGN (3-12)</label>
          <input id="inp-callsign" class="pixel-input" value="${esc(
            ctx.profile.callsign
          )}" minlength="3" maxlength="12" />
        </div>
        <div class="form-row">
          <label class="mono-dim" style="width:120px">TAIL FIN ACCENT</label>
          <select id="sel-tail-color" class="pixel-select">${colorOptions}</select>
        </div>
        <div class="form-row">
          <label class="mono-dim" style="width:120px">INVERT PITCH (Y)</label>
          <input id="chk-invert-y" type="checkbox" ${ctx.profile.invertY ? 'checked' : ''} />
        </div>
        <div class="form-row">
          <label class="mono-dim" style="width:120px">SENSITIVITY</label>
          <input id="rng-sens" type="range" min="0.4" max="2.0" step="0.1" value="${
            ctx.profile.sensitivity
          }" />
          <span id="lbl-sens" class="mono-dim">${ctx.profile.sensitivity.toFixed(1)}x</span>
        </div>
        <div class="form-row">
          <button id="btn-save-pilot" class="pixel-btn primary">SAVE PROFILE</button>
        </div>
      </div>
    `;

    const rng = container.querySelector('#rng-sens') as HTMLInputElement;
    const lbl = container.querySelector('#lbl-sens') as HTMLElement;
    rng.addEventListener('input', () => {
      lbl.textContent = `${Number(rng.value).toFixed(1)}x`;
    });

    container.querySelector('#btn-save-pilot')?.addEventListener('click', async () => {
      const callsign = (container.querySelector('#inp-callsign') as HTMLInputElement).value;
      const tailColor = (container.querySelector('#sel-tail-color') as HTMLSelectElement)
        .value as TailAccentColor;
      const invertY = (container.querySelector('#chk-invert-y') as HTMLInputElement).checked;
      const sensitivity = Number(rng.value);
      try {
        const updated = await saveProfile({ callsign, tailColor, invertY, sensitivity });
        ctx.onProfileUpdated(updated);
        ctx.onToast(`CALLSIGN SET: ${updated.callsign}`);
      } catch (err) {
        ctx.onToast((err as Error).message);
      }
    });
  }
}
