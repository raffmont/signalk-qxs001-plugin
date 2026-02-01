'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { EvdevKeyReader } = require('./lib/evdev-reader');
const { getKipDisplays, getSelfPathValue, putSelfPathValue, buildBaseUrl } = require('./lib/kip-client');

const PLUGIN_ID = 'signalk-qxs-plugin';
const PLUGIN_NAME = 'QXS Remote for KIP Displays';

/**
 * Default Linux HID key codes (common):
 * - KEY_VOLUMEDOWN = 114
 * - KEY_VOLUMEUP   = 115
 * - KEY_NEXTSONG   = 163
 * - KEY_PREVIOUSSONG = 165
 *
 * If your device emits different codes, make them configurable.
 */
const DEFAULT_KEYMAP = {
  VOLUME_UP: 115,
  VOLUME_DOWN: 114,
  NEXT: 163,
  PREV: 165
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function buildOptions(settings = {}) {
  const keymap = settings?.keymap ?? {};
  return {
    devicePath: typeof settings.devicePath === 'string' && settings.devicePath.trim() ? settings.devicePath.trim() : null,
    autodetectSeconds: Math.max(1, Number(settings.autodetectSeconds ?? 6)),
    qxs001Autodetect: settings.qxs001Autodetect !== undefined ? Boolean(settings.qxs001Autodetect) : true,
    kipUuid: typeof settings.kipUuid === 'string' && settings.kipUuid.trim() ? settings.kipUuid.trim() : null,
    httpToken: typeof settings.httpToken === 'string' && settings.httpToken.trim() ? settings.httpToken.trim() : null,
    keymap: {
      VOLUME_UP: Number(keymap.VOLUME_UP ?? DEFAULT_KEYMAP.VOLUME_UP),
      VOLUME_DOWN: Number(keymap.VOLUME_DOWN ?? DEFAULT_KEYMAP.VOLUME_DOWN),
      NEXT: Number(keymap.NEXT ?? DEFAULT_KEYMAP.NEXT),
      PREV: Number(keymap.PREV ?? DEFAULT_KEYMAP.PREV)
    }
  };
}

function mergeOptions(current, updates) {
  const merged = {
    ...current,
    ...updates,
    keymap: {
      ...(current?.keymap ?? {}),
      ...(updates?.keymap ?? {})
    }
  };
  return buildOptions(merged);
}

function findQxs001DevicePath() {
  const byIdPath = '/dev/input/by-id';
  try {
    const entries = fs.readdirSync(byIdPath);
    const matches = entries.filter((entry) => /qxs[-_\s]*001/i.test(entry) && entry.includes('event'));
    if (!matches.length) return null;
    const preferred = matches.find((entry) => entry.includes('event-kbd')) || matches[0];
    return path.join(byIdPath, preferred);
  } catch {
    return null;
  }
}

module.exports = function (app) {
  let router;
  let server;
  let unsub = null;
  let restartPlugin = null;

  // Runtime state
  const state = {
    devicePath: null,
    kipUuid: null,
    displays: [],           // from /plugins/kip/displays (opaque objects)
    displayIds: [],         // derived stable ids
    activeDisplayId: null,  // stored via /plugins/qxs/display
    dashboardsByDisplay: {},// displayId -> array (from self.displays.<uuid>.screenIndex)
    activeDashboardByDisplay: {}, // displayId -> number (from self.displays.<uuid>.activeScreen)
    lastUpdated: null,
    status: 'init',
    errors: [],
    options: buildOptions()
  };

  function setStatus(msg) {
    state.status = msg;
    app.setPluginStatus(msg);
  }

  function setError(err) {
    const m = err && err.message ? err.message : String(err);
    state.errors.push({ t: new Date().toISOString(), m });
    app.setPluginError(m);
  }

  function publishQxsStateDelta() {
    // Publish a small state snapshot into Signal K so others can observe.
    // (This does not replace the REST endpoints requested.)
    const values = [
      { path: 'plugins.qxs.display', value: state.activeDisplayId },
      { path: 'plugins.qxs.status', value: state.status }
    ];
    app.handleMessage(PLUGIN_ID, {
      context: 'vessels.self',
      updates: [{ source: { label: PLUGIN_ID }, timestamp: new Date().toISOString(), values }]
    });
  }

  async function readPluginOptions() {
    if (typeof app.readPluginOptions === 'function') {
      try {
        if (app.readPluginOptions.length >= 1) return await app.readPluginOptions(PLUGIN_ID);
        return await app.readPluginOptions();
      } catch {}
    }
    if (typeof app.getPluginOptions === 'function') {
      try {
        if (app.getPluginOptions.length >= 1) return await app.getPluginOptions(PLUGIN_ID);
        return await app.getPluginOptions();
      } catch {}
    }
    return state.options;
  }

  async function savePluginOptions(options) {
    if (typeof app.savePluginOptions === 'function') {
      if (app.savePluginOptions.length >= 2) {
        await app.savePluginOptions(PLUGIN_ID, options);
      } else {
        await app.savePluginOptions(options);
      }
      return true;
    }
    if (typeof app.saveOptions === 'function') {
      if (app.saveOptions.length >= 2) {
        await app.saveOptions(PLUGIN_ID, options);
      } else {
        await app.saveOptions(options);
      }
      return true;
    }
    return false;
  }

  // ---- Display utilities ----

  function deriveDisplayId(d, idx) {
    // KIP may return objects with id/uuid/name; treat generically.
    return d?.id || d?.uuid || d?.displayId || d?.name || `display-${idx}`;
  }

  function ensureActiveDisplayValid() {
    if (!state.displayIds.length) {
      state.activeDisplayId = null;
      return;
    }
    if (!state.activeDisplayId || !state.displayIds.includes(state.activeDisplayId)) {
      state.activeDisplayId = state.displayIds[0] || null;
    }
  }

  function nextDisplay(step) {
    if (!state.displayIds.length) {
      state.activeDisplayId = null;
      return null;
    }
    ensureActiveDisplayValid();
    const i = state.displayIds.indexOf(state.activeDisplayId);
    const j = (i + step + state.displayIds.length) % state.displayIds.length;
    state.activeDisplayId = state.displayIds[j];
    return state.activeDisplayId;
  }

  function getDashboards(displayId) {
    const arr = state.dashboardsByDisplay[displayId];
    return Array.isArray(arr) ? arr : null;
  }

  function getActiveDashboardIndex(displayId) {
    const v = state.activeDashboardByDisplay[displayId];
    return Number.isInteger(v) ? v : 0;
  }

  async function writeActiveDashboard(displayId, newIndex, options) {
    // Determine KIP UUID and write to self.displays.<uuid>.activeScreen
    if (!state.kipUuid) return;

    const dashboards = getDashboards(displayId);
    if (!dashboards || dashboards.length === 0) return;

    const idx = clamp(newIndex, 0, dashboards.length - 1);
    const skPath = `displays.${state.kipUuid}.activeScreen`;

    await putSelfPathValue(app, skPath, idx, options.httpToken);
    state.activeDashboardByDisplay[displayId] = idx;
  }

  // ---- KIP integration (polling) ----

  async function refreshKip(options) {
    const displays = await getKipDisplays(app, options.httpToken);
    state.displays = Array.isArray(displays) ? displays : [];
    state.displayIds = state.displays.map(deriveDisplayId);
    // Try to infer kipUuid if not set: KIP displays entries often include a uuid
    if (!state.kipUuid) {
      const u = state.displays.find(d => d?.kipUuid || d?.uuid)?.kipUuid || state.displays.find(d => d?.KIP_UUID)?.KIP_UUID;
      if (u) state.kipUuid = u;
    }

    ensureActiveDisplayValid();
    state.lastUpdated = new Date().toISOString();
    publishQxsStateDelta();
  }

  async function refreshDashboards(options) {
    if (!state.kipUuid) return;

    // When KIP loads a display and its config profile, it publishes dashboards array to:
    // self.displays.<KIP_UUID>.screenIndex
    // We read it and store as dashboardsByDisplay[activeDisplayId]
    const screenIndexPath = `displays.${state.kipUuid}.screenIndex`;
    const activeScreenPath = `displays.${state.kipUuid}.activeScreen`;

    let dashboards;
    let activeScreen;
    try {
      dashboards = await getSelfPathValue(app, screenIndexPath, options.httpToken);
    } catch (e) {
      // Not available yet; ignore
      dashboards = null;
    }
    try {
      const as = await getSelfPathValue(app, activeScreenPath, options.httpToken);
      activeScreen = (typeof as === 'object' && as && 'value' in as) ? as.value : as;
    } catch {
      activeScreen = 0;
    }

    // If dashboards is a Signal K leaf object { value: [...] } normalize
    const dashArray = (dashboards && typeof dashboards === 'object' && 'value' in dashboards) ? dashboards.value : dashboards;

    if (state.activeDisplayId) {
      if (Array.isArray(dashArray)) {
        state.dashboardsByDisplay[state.activeDisplayId] = dashArray;
      } else {
        state.dashboardsByDisplay[state.activeDisplayId] = null;
      }
      if (Number.isInteger(activeScreen)) {
        state.activeDashboardByDisplay[state.activeDisplayId] = activeScreen;
      }
    }
  }

  // ---- QXS key handling ----

  async function onKeyEvent(ev, options) {
    // We react on key DOWN only to avoid double-trigger.
    if (ev.value !== 1) return;

    if (ev.code === options.keymap.VOLUME_UP) {
      nextDisplay(+1);
      ensureActiveDisplayValid();
      publishQxsStateDelta();
      return;
    }
    if (ev.code === options.keymap.VOLUME_DOWN) {
      nextDisplay(-1);
      ensureActiveDisplayValid();
      publishQxsStateDelta();
      return;
    }
    if (ev.code === options.keymap.NEXT) {
      const d = state.activeDisplayId;
      if (!d) return;
      const dashboards = getDashboards(d);
      const cur = getActiveDashboardIndex(d);
      if (!dashboards || dashboards.length === 0) return;
      await writeActiveDashboard(d, cur + 1, options);
      return;
    }
    if (ev.code === options.keymap.PREV) {
      const d = state.activeDisplayId;
      if (!d) return;
      const dashboards = getDashboards(d);
      const cur = getActiveDashboardIndex(d);
      if (!dashboards || dashboards.length === 0) return;
      await writeActiveDashboard(d, cur - 1, options);
      return;
    }
  }

  // ---- REST endpoints + web UI ----

  function buildRouter(options) {
    const r = express.Router();

    // Serve the web UI
    r.use('/', express.static(__dirname + '/public'));

    // REST-ish endpoints
    r.get('/api/status', async (req, res) => {
      res.json({
        plugin: PLUGIN_ID,
        baseUrl: buildBaseUrl(app),
        kipUuid: state.kipUuid,
        displays: state.displays.map((d, i) => ({ id: deriveDisplayId(d, i), raw: d })),
        activeDisplayId: state.activeDisplayId,
        dashboardsByDisplay: state.dashboardsByDisplay,
        activeDashboardByDisplay: state.activeDashboardByDisplay,
        lastUpdated: state.lastUpdated,
        status: state.status,
        errors: state.errors.slice(-10)
      });
    });

    r.get('/api/config', async (req, res) => {
      const savedOptions = await readPluginOptions();
      res.json({
        options: mergeOptions(state.options, savedOptions || {}),
        canSave: typeof app.savePluginOptions === 'function' || typeof app.saveOptions === 'function',
        canRestart: typeof restartPlugin === 'function'
      });
    });

    r.post('/api/config', express.json(), async (req, res) => {
      const incoming = req.body?.options ?? req.body ?? {};
      const merged = mergeOptions(state.options, incoming);
      const saved = await savePluginOptions(merged);
      state.options = merged;
      if (merged.kipUuid) state.kipUuid = merged.kipUuid;

      let restarting = false;
      if (req.body?.restart && typeof restartPlugin === 'function') {
        restarting = true;
        restartPlugin();
      }

      res.json({ ok: saved, restarting, options: merged });
    });

    r.post('/api/autodetect', express.json(), async (req, res) => {
      const seconds = clamp(Number(req.body?.seconds ?? state.options.autodetectSeconds ?? 6), 1, 60);
      const minKeys = Math.max(1, Number(req.body?.minKeys ?? 1));
      const preferById = req.body?.preferById ?? state.options.qxs001Autodetect;

      try {
        if (preferById) {
          const byId = findQxs001DevicePath();
          if (byId) return res.json({ path: byId, method: 'by-id' });
        }
        const reader = new EvdevKeyReader();
        const detected = await reader.autodetectDevice({ seconds, minKeys });
        if (!detected) return res.status(404).json({ path: null, method: 'sniff' });
        return res.json({ path: detected, method: 'sniff' });
      } catch (e) {
        return res.status(500).json({ error: e.message || String(e) });
      }
    });

    // /plugins/qxs/display GET/PUT (requested "property")
    r.get('/display', (req, res) => {
      res.json({ value: state.activeDisplayId });
    });

    r.put('/display', express.json(), (req, res) => {
      const v = req.body?.value ?? req.body?.displayId ?? null;
      if (v === null) {
        state.activeDisplayId = null;
      } else if (state.displayIds.includes(v)) {
        state.activeDisplayId = v;
      } else {
        // If unavailable -> default to first or null as requested
        state.activeDisplayId = state.displayIds[0] || null;
      }
      publishQxsStateDelta();
      res.json({ value: state.activeDisplayId });
    });

    r.put('/dashboard', express.json(), async (req, res) => {
      const displayId = req.body?.displayId ?? state.activeDisplayId;
      const idx = Number(req.body?.index);
      if (!displayId) return res.status(400).json({ error: 'no displayId' });
      if (!Number.isFinite(idx)) return res.status(400).json({ error: 'invalid index' });

      try {
        await writeActiveDashboard(displayId, idx, options);
        res.json({ ok: true, displayId, index: state.activeDashboardByDisplay[displayId] ?? 0 });
      } catch (e) {
        res.status(500).json({ error: e.message || String(e) });
      }
    });

    return r;
  }

  // ---- Plugin interface ----

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'Use a QXS Bluetooth remote to select KIP displays (vol up/down) and dashboards (prev/next).',

    schema: {
      type: 'object',
      properties: {
        devicePath: {
          type: 'string',
          title: 'Input device path (optional)',
          description: 'e.g., /dev/input/event5. Leave empty for auto-detect.'
        },
        autodetectSeconds: {
          type: 'number',
          title: 'Autodetect sniff window (seconds)',
          default: 6
        },
        qxs001Autodetect: {
          type: 'boolean',
          title: 'QXS 001 autodetect',
          description: 'Try to auto-detect a QXS 001 device from /dev/input/by-id before sniffing.',
          default: true
        },
        kipUuid: {
          type: 'string',
          title: 'KIP UUID (optional)',
          description: 'If known, set it; otherwise inferred from /plugins/kip/displays.'
        },
        httpToken: {
          type: 'string',
          title: 'Signal K JWT token (optional)',
          description: 'If your server requires auth for local API calls.'
        },
    keymap: {
      type: 'object',
      title: 'Key codes (optional)',
      properties: {
        VOLUME_UP: { type: 'number', default: DEFAULT_KEYMAP.VOLUME_UP },
            VOLUME_DOWN: { type: 'number', default: DEFAULT_KEYMAP.VOLUME_DOWN },
            NEXT: { type: 'number', default: DEFAULT_KEYMAP.NEXT },
            PREV: { type: 'number', default: DEFAULT_KEYMAP.PREV }
          }
        }
    }
  },

    start: async function (settings, restart) {
      const options = buildOptions(settings);

      restartPlugin = restart;
      state.options = options;
      state.kipUuid = options.kipUuid || null;

      try {
        router = buildRouter(options);

        // Signal K plugin router mount: /plugins/<plugin-id>/
        // Most Signal K servers expose app.registerPluginRouter()
        if (typeof app.registerPluginRouter === 'function') {
          app.registerPluginRouter(PLUGIN_ID, router);
        } else if (typeof app.registerRouter === 'function') {
          app.registerRouter(`/plugins/${PLUGIN_ID}`, router);
        } else if (app?.app && typeof app.app.use === 'function') {
          // fallback: raw express app
          app.app.use(`/plugins/${PLUGIN_ID}`, router);
        } else {
          throw new Error('Cannot register plugin router (Signal K API not found)');
        }

        setStatus('Starting…');

        // Fetch displays from KIP
        await refreshKip(options);

        // Ensure display stored is valid; default to first or null
        ensureActiveDisplayValid();
        publishQxsStateDelta();

        // Start polling dashboards published by KIP
        let polling = true;
        const poll = async () => {
          while (polling) {
            try {
              await refreshKip(options);
              await refreshDashboards(options);
              setStatus(`OK (display=${state.activeDisplayId ?? 'null'})`);
            } catch (e) {
              setStatus('Waiting for KIP…');
              // if KIP not ready yet, keep trying
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 1000));
          }
        };
        poll();

        // Start evdev reader
        const reader = new EvdevKeyReader({ devicePath: options.devicePath });

        if (!options.devicePath) {
          if (options.qxs001Autodetect) {
            const detectedPath = findQxs001DevicePath();
            if (detectedPath) {
              setStatus(`Detected QXS 001 at ${detectedPath}`);
              options.devicePath = detectedPath;
              reader.devicePath = detectedPath;
            }
          }
          if (!options.devicePath) {
            setStatus('Autodetecting QXS input device… press some buttons');
            const picked = await reader.autodetectDevice({ seconds: options.autodetectSeconds, minKeys: 1 });
            if (!picked) {
              setStatus('No key activity detected. Set devicePath explicitly.');
              setError(new Error('Autodetect failed: no EV_KEY activity detected'));
              return;
            }
            options.devicePath = picked;
            reader.devicePath = picked;
          }
        }

        state.devicePath = options.devicePath;

        reader.on('key', async (ev) => {
          try { await onKeyEvent(ev, options); }
          catch (e) { setError(e); }
        });
        reader.on('error', (e) => setError(e));
        reader.on('close', () => setStatus('Input device closed; restart plugin to reconnect'));

        reader.start();
        server = { reader, pollingStop: () => { polling = false; } };

        setStatus(`Listening on ${state.devicePath}`);
      } catch (e) {
        setError(e);
        setStatus('Error');
      }
    },

    stop: function () {
      try {
        if (server?.pollingStop) server.pollingStop();
        if (server?.reader) server.reader.stop();
      } catch {}
      server = null;
      setStatus('Stopped');
    }
  };
};
