"use strict";

const path = require("path");
const express = require("express");

const { startReading, KEY_MAP } = require("./lib/qxs_input_raw");
const { requestLocal } = require("./lib/http_local");
const { requestAny } = require("./lib/http_any");
const { loadState, saveState } = require("./lib/storage");

const PLUGIN_ID = "signalk-qxs001-plugin";

function getIn(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

module.exports = function (app) {
  const persistent = loadState(app, { bindings: {} });
  const savePersistent = () => saveState(app, persistent);

  let lastKey = null;
  let lastKeyAt = null;
  let lastKeyCode = null;

  let kipDisplays = [];
  let kipDashboardsByDisplay = {};
  let kipScreenIndexByDisplay = {};
  let selectedDisplayId = null;

  let readers = [];
  let screenPollTimer = null;

  function getServerPort() {
    const port = getIn(app, ["config", "settings", "port"]);
    return Number(port) || 3000;
  }

  function publishToSignalK(extraValues = []) {
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          source: { label: PLUGIN_ID },
          timestamp: new Date().toISOString(),
          values: [
            { path: "self.qxs001.lastKey", value: lastKey },
            { path: "self.qxs001.lastKeyAt", value: lastKeyAt },
            { path: "self.qxs001.lastKeyCode", value: lastKeyCode },
            { path: "self.qxs001.kip.selectedDisplayId", value: selectedDisplayId },
            ...extraValues,
          ],
        },
      ],
    });
  }

  function ensureBindingContainer(displayId) {
    if (!persistent.bindings[displayId]) persistent.bindings[displayId] = {};
    return persistent.bindings[displayId];
  }

  function getPlayAction(displayId, dashboardId) {
    const m = persistent.bindings[displayId];
    if (!m) return { type: "none" };
    return m[String(dashboardId)] || { type: "none" };
  }

  function mergeBindings(src) {
    src = src || {};
    for (const displayId of Object.keys(src)) {
      const dst = ensureBindingContainer(displayId);
      const incoming = src[displayId] || {};
      for (const dashId of Object.keys(incoming)) dst[dashId] = incoming[dashId];
    }
    savePersistent();
  }

  async function kipGet(p) {
    const port = getServerPort();
    const res = await requestLocal({ port, method: "GET", path: p });
    if (res.status < 200 || res.status >= 300) throw new Error(`KIP GET ${p} -> HTTP ${res.status}`);
    return res.bodyJson;
  }

  function normalizeDisplayList(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.displays)) return payload.displays;
    if (payload && Array.isArray(payload.items)) return payload.items;
    return [];
  }

  function normalizeDashboards(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.dashboards)) return payload.dashboards;
    if (payload && Array.isArray(payload.items)) return payload.items;
    return [];
  }

  function normalizeScreenIndex(payload) {
    if (Number.isFinite(payload)) return Number(payload);
    if (payload && Number.isFinite(payload.screenIndex)) return Number(payload.screenIndex);
    if (payload && Number.isFinite(payload.index)) return Number(payload.index);
    if (payload && Number.isFinite(payload.activeScreen)) return Number(payload.activeScreen);
    return null;
  }

  async function kipPost(p, json) {
    const port = getServerPort();
    const res = await requestLocal({ port, method: "POST", path: p, json });
    if (res.status < 200 || res.status >= 300) throw new Error(`KIP POST ${p} -> HTTP ${res.status} (${res.bodyText})`);
    return res.bodyJson;
  }

  async function refreshKipDisplaysAndDashboards() {
    const displays = await kipGet("/plugins/kip/displays");
    kipDisplays = normalizeDisplayList(displays);

    if (kipDisplays.length && !selectedDisplayId) selectedDisplayId = kipDisplays[0].displayId;
    if (kipDisplays.length && selectedDisplayId && !kipDisplays.some((d) => d.displayId === selectedDisplayId)) {
      selectedDisplayId = kipDisplays[0].displayId;
    }

    const newDash = {};
    for (const d of kipDisplays) {
      try {
        const dashboards = await kipGet(`/plugins/kip/displays/${encodeURIComponent(d.displayId)}`);
        newDash[d.displayId] = normalizeDashboards(dashboards);
      } catch (_) {
        newDash[d.displayId] = [];
      }
    }
    kipDashboardsByDisplay = newDash;
  }

  async function refreshKipScreenIndexes() {
    for (const d of kipDisplays) {
      try {
        const idx = await kipGet(`/plugins/kip/displays/${encodeURIComponent(d.displayId)}/screenIndex`);
        const normalized = normalizeScreenIndex(idx);
        kipScreenIndexByDisplay[d.displayId] = Number.isFinite(normalized) ? normalized : 0;
      } catch (_) {
        if (kipScreenIndexByDisplay[d.displayId] == null) kipScreenIndexByDisplay[d.displayId] = 0;
      }
    }
  }

  async function kipSetActiveScreen(displayId, newIndex) {
    await kipPost(`/plugins/kip/displays/${encodeURIComponent(displayId)}/activeScreen`, { changeId: newIndex });
    await refreshKipScreenIndexes();
  }

  async function executePlayAction(action) {
    if (!action || action.type === "none") return;

    if (action.type === "rest") {
      const method = String(action.method || "GET").toUpperCase();
      const url = String(action.url || "").trim();
      const params = action.params && typeof action.params === "object" ? action.params : undefined;
      const body = action.body;

      if (url) {
        const res = await requestAny({
          url,
          method,
          query: params,
          json: method === "POST" ? (body ?? {}) : undefined,
        });
        app.setPluginStatus(`Play REST ${method} ${url} -> ${res.status}`);
        return;
      }

      const p = String(action.path || "/").trim();
      const port = getServerPort();
      const res = await requestLocal({ port, method, path: p, json: method === "POST" ? (body ?? {}) : undefined });
      app.setPluginStatus(`Play REST ${method} ${p} -> ${res.status}`);
      return;
    }

    if (action.type === "signalk") {
      const key = String(action.key || "").trim();
      if (!key) return;
      publishToSignalK([{ path: key, value: action.value }]);
      app.setPluginStatus(`Play SK write: ${key}`);
    }
  }

  function normalizeBindingFromSettings(item) {
    const screenId = String(item?.screenId || item?.displayId || "").trim();
    const dashboardId = String(item?.dashboardId || "").trim();
    if (!screenId || !dashboardId) return null;

    const actionType = String(item?.actionType || item?.action?.type || "none");

    if (actionType === "rest") {
      const url = String(item.url || item?.action?.url || "").trim();
      const method = String(item.method || item?.action?.method || "GET").toUpperCase();
      const params =
        item.params && typeof item.params === "object" ? item.params : item?.action?.params && typeof item.action.params === "object" ? item.action.params : {};
      const body = item.body !== undefined ? item.body : item?.action?.body ?? {};
      return { screenId, dashboardId, action: { type: "rest", url, method, params, body } };
    }

    if (actionType === "signalk") {
      const key = String(item.key || item?.action?.key || "").trim();
      const value = item.value !== undefined ? item.value : item?.action?.value;
      return { screenId, dashboardId, action: { type: "signalk", key, value } };
    }

    return { screenId, dashboardId, action: { type: "none" } };
  }

  function applyPlayBindingsFromSettings(playBindings) {
    if (!Array.isArray(playBindings)) return;
    const merge = {};
    for (const item of playBindings) {
      const n = normalizeBindingFromSettings(item);
      if (!n) continue;
      if (!merge[n.screenId]) merge[n.screenId] = {};
      merge[n.screenId][n.dashboardId] = n.action;
    }
    mergeBindings(merge);
  }

  const plugin = { id: PLUGIN_ID, name: "QXS-001 Key Monitor" };

  plugin.schema = () => ({
    type: "object",
    properties: {
      eventDevices: {
        type: "array",
        title: "Input event devices to read",
        items: { type: "string" },
        default: ["/dev/input/event6", "/dev/input/event7"],
      },
      publishOn: {
        type: "string",
        title: "Record key when...",
        enum: ["down", "up", "repeat", "any"],
        default: "down",
      },
      keyVolumeUp: { type: "string", title: "Display Next", default: "KEY_VOLUMEUP" },
      keyVolumeDown: { type: "string", title: "Display Previous", default: "KEY_VOLUMEDOWN" },
      keyNext: { type: "string", title: "Dashboard Next", default: "KEY_NEXTSONG" },
      keyPrev: { type: "string", title: "Dashboard Previous", default: "KEY_PREVIOUSSONG" },
      keyPlay: { type: "string", title: "Play Button", default: "KEY_PLAYPAUSE" },

      playBindings: {
        type: "array",
        title: "Play button actions (per screenId + dashboardId)",
        default: [],
        items: {
          type: "object",
          properties: {
            screenId: { type: "string", title: "Screen id (KIP displayId)" },
            dashboardId: { type: "string", title: "Dashboard id (KIP dashboard id)" },

            actionType: { type: "string", title: "Action type", enum: ["none", "rest", "signalk"], default: "none" },

            url: { type: "string", title: "REST URL (http/https)" },
            method: { type: "string", title: "HTTP method", enum: ["GET", "POST"], default: "GET" },
            params: { type: "object", title: "Query parameters", default: {} },
            body: { type: "object", title: "JSON body (POST)", default: {} },

            key: { type: "string", title: "Signal K document key/path" },
            value: { title: "Value to write" },

            action: { type: "object", title: "Advanced: nested action object (optional)" },
          },
        },
      },
    },
  });

  plugin.registerWithRouter = (router) => {
    router.use("/", express.static(path.join(__dirname, "..", "public")));

    router.get("/api/keys", (req, res) => {
      res.json({
        keyMap: KEY_MAP,
        layout: [
          ["KEY_PREVIOUSSONG", "KEY_PLAYPAUSE", "KEY_NEXTSONG"],
          ["KEY_VOLUMEUP", "KEY_VOLUMEDOWN", "KEY_ENTER"],
          ["KEY_UP"],
          ["KEY_LEFT", "KEY_DOWN", "KEY_RIGHT"],
        ],
        last: { lastKey, lastKeyAt, lastKeyCode },
      });
    });

    router.get("/api/state", async (req, res) => {
      try {
        await refreshKipDisplaysAndDashboards();
        await refreshKipScreenIndexes();
      } catch (_) {}

      const displaysView = kipDisplays.map((d) => {
        const dashboards = kipDashboardsByDisplay[d.displayId] || [];
        const screenIndex = kipScreenIndexByDisplay[d.displayId] ?? 0;
        const bindings = {};
        for (const dash of dashboards) bindings[String(dash.id)] = getPlayAction(d.displayId, dash.id);
        return { displayId: d.displayId, displayName: d.displayName, screenIndex, dashboards, bindings };
      });

      res.json({
        lastKey,
        lastKeyAt,
        lastKeyCode,
        selected: {
          selectedDisplayId,
          screenIndex: selectedDisplayId ? kipScreenIndexByDisplay[selectedDisplayId] ?? 0 : 0,
        },
        displays: displaysView,
      });
    });

    router.post("/api/kip/activeScreen", express.json(), async (req, res) => {
      const displayId = String(req.body?.displayId || "").trim() || selectedDisplayId;
      const changeId = Number(req.body?.changeId);
      if (!displayId) return res.status(400).json({ error: "Missing displayId" });
      if (!Number.isFinite(changeId) || changeId < 0) return res.status(400).json({ error: "Missing/invalid changeId" });

      try {
        await kipSetActiveScreen(displayId, changeId);
        res.json({ ok: true, displayId, screenIndex: kipScreenIndexByDisplay[displayId] ?? changeId });
      } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
      }
    });

    router.post("/api/triggerPlay", async (req, res) => {
      if (!selectedDisplayId) return res.status(400).json({ error: "No selected display" });

      const dashboards = kipDashboardsByDisplay[selectedDisplayId] || [];
      const idx = kipScreenIndexByDisplay[selectedDisplayId] ?? 0;
      const dash = dashboards[idx];
      if (!dash) return res.status(400).json({ error: "No dashboard at current index" });

      const action = getPlayAction(selectedDisplayId, dash.id);
      try {
        await executePlayAction(action);
        res.json({ ok: true, action, displayId: selectedDisplayId, dashboardId: dash.id });
      } catch (e) {
        res.status(500).json({ error: String(e.message || e), action });
      }
    });
  };

  plugin.start = async (settings) => {
    const eventDevices = Array.isArray(settings?.eventDevices) ? settings.eventDevices : ["/dev/input/event6", "/dev/input/event7"];
    const publishOn = settings?.publishOn || "down";

    const keyVolumeUp = String(settings?.keyVolumeUp || "KEY_VOLUMEUP");
    const keyVolumeDown = String(settings?.keyVolumeDown || "KEY_VOLUMEDOWN");
    const keyNext = String(settings?.keyNext || "KEY_NEXTSONG");
    const keyPrev = String(settings?.keyPrev || "KEY_PREVIOUSSONG");
    const keyPlay = String(settings?.keyPlay || "KEY_PLAYPAUSE");

    applyPlayBindingsFromSettings(settings?.playBindings);

    try {
      await refreshKipDisplaysAndDashboards();
      await refreshKipScreenIndexes();
    } catch (e) {
      app.setPluginStatus(`Running (KIP not ready: ${String(e.message || e)})`);
    }

    screenPollTimer = setInterval(() => {
      refreshKipScreenIndexes().catch(() => {});
    }, 2000);

    async function handleKey(evt) {
      if (evt.typeName !== "EV_KEY") return;

      const record = publishOn === "any" || evt.action === publishOn;
      if (record) {
        lastKey = evt.codeName;
        lastKeyAt = new Date().toISOString();
        lastKeyCode = evt.code;
        publishToSignalK();
      }

      if (evt.action !== "down") return;

      if (kipDisplays.length === 0) {
        try { await refreshKipDisplaysAndDashboards(); } catch (_) {}
      }

      if (evt.codeName === keyVolumeUp || evt.codeName === keyVolumeDown) {
        if (kipDisplays.length === 0) return;
        const ids = kipDisplays.map((d) => d.displayId);
        const cur = selectedDisplayId && ids.includes(selectedDisplayId) ? ids.indexOf(selectedDisplayId) : 0;
        const dir = evt.codeName === keyVolumeUp ? +1 : -1;
        selectedDisplayId = ids[(cur + dir + ids.length) % ids.length];
        publishToSignalK();
        return;
      }

      if (evt.codeName === keyNext || evt.codeName === keyPrev) {
        if (!selectedDisplayId) return;
        const dashboards = kipDashboardsByDisplay[selectedDisplayId] || [];
        if (dashboards.length === 0) return;
        const curIdx = kipScreenIndexByDisplay[selectedDisplayId] ?? 0;
        const dir = evt.codeName === keyNext ? +1 : -1;
        const newIdx = (curIdx + dir + dashboards.length) % dashboards.length;
        try { await kipSetActiveScreen(selectedDisplayId, newIdx); } catch (_) {}
        return;
      }

      if (evt.codeName === keyPlay) {
        if (!selectedDisplayId) return;
        const dashboards = kipDashboardsByDisplay[selectedDisplayId] || [];
        const idx = kipScreenIndexByDisplay[selectedDisplayId] ?? 0;
        const dash = dashboards[idx];
        if (!dash) return;
        await executePlayAction(getPlayAction(selectedDisplayId, dash.id));
      }
    }

    readers = eventDevices
      .map((devPath) => {
        try {
          return startReading(devPath, (evt) => handleKey(evt).catch(() => {}));
        } catch (err) {
          app.setPluginError(`Cannot read ${devPath}. Ensure user is in 'input' group. ${err.message}`);
          return null;
        }
      })
      .filter(Boolean);

    app.setPluginStatus(`Running. Reading: ${eventDevices.join(", ")}`);
  };

  plugin.stop = () => {
    for (const r of readers) {
      try { r.stop(); } catch (_) {}
    }
    readers = [];
    if (screenPollTimer) {
      try { clearInterval(screenPollTimer); } catch (_) {}
      screenPollTimer = null;
    }
    app.setPluginStatus("Stopped.");
  };

  return plugin;
};
