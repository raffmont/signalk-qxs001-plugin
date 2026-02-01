async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function el(tag, attrs={}, children=[]) {
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

function byId(id) {
  return document.getElementById(id);
}

function setConfigStatus(message, level = 'info') {
  const node = byId('config-status');
  if (!node) return;
  node.textContent = message || '';
  node.className = `status${level === 'warn' ? ' warn' : ''}`;
}

function renderConfig(config) {
  if (!config) return;
  const options = config.options || {};
  const keymap = options.keymap || {};

  byId('config-device-path').value = options.devicePath || '';
  byId('config-autodetect-seconds').value = options.autodetectSeconds ?? 6;
  byId('config-qxs001').checked = Boolean(options.qxs001Autodetect);
  byId('config-kip-uuid').value = options.kipUuid || '';
  byId('config-http-token').value = options.httpToken || '';
  byId('config-keymap-volume-up').value = keymap.VOLUME_UP ?? '';
  byId('config-keymap-volume-down').value = keymap.VOLUME_DOWN ?? '';
  byId('config-keymap-next').value = keymap.NEXT ?? '';
  byId('config-keymap-prev').value = keymap.PREV ?? '';

  const saveButton = byId('config-save');
  const restartToggle = byId('config-restart');
  if (saveButton) saveButton.disabled = !config.canSave;
  if (restartToggle) restartToggle.disabled = !config.canRestart;
  if (!config.canSave) {
    setConfigStatus('Saving settings is not supported by this Signal K host. Update config in the server UI.', 'warn');
  } else {
    setConfigStatus('Ready.');
  }
}

async function refreshConfig() {
  const cfg = await api('./api/config');
  renderConfig(cfg);
  return cfg;
}

function collectConfigFromForm() {
  return {
    devicePath: byId('config-device-path').value.trim(),
    autodetectSeconds: Number(byId('config-autodetect-seconds').value || 6),
    qxs001Autodetect: byId('config-qxs001').checked,
    kipUuid: byId('config-kip-uuid').value.trim(),
    httpToken: byId('config-http-token').value.trim(),
    keymap: {
      VOLUME_UP: Number(byId('config-keymap-volume-up').value || 0) || undefined,
      VOLUME_DOWN: Number(byId('config-keymap-volume-down').value || 0) || undefined,
      NEXT: Number(byId('config-keymap-next').value || 0) || undefined,
      PREV: Number(byId('config-keymap-prev').value || 0) || undefined
    }
  };
}

function attachConfigHandlers() {
  const form = byId('config-form');
  const autodetectButton = byId('config-autodetect');
  if (!form || !autodetectButton) return;

  autodetectButton.addEventListener('click', async () => {
    try {
      autodetectButton.disabled = true;
      setConfigStatus('Listening for QXS key activity… press a remote button.');
      const seconds = Number(byId('config-autodetect-seconds').value || 6);
      const preferById = byId('config-qxs001').checked;
      const res = await api('./api/autodetect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds, preferById })
      });
      byId('config-device-path').value = res.path || '';
      setConfigStatus(res.path ? `Detected device: ${res.path} (${res.method})` : 'No device detected.');
    } catch (err) {
      setConfigStatus(err.message || 'Autodetect failed.', 'warn');
    } finally {
      autodetectButton.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = collectConfigFromForm();
      const restart = byId('config-restart').checked;
      setConfigStatus('Saving settings…');
      const res = await api('./api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: payload, restart })
      });
      if (res?.restarting) {
        setConfigStatus('Settings saved. Plugin restarting…');
      } else {
        setConfigStatus('Settings saved.');
      }
      await refreshConfig();
    } catch (err) {
      setConfigStatus(err.message || 'Save failed.', 'warn');
    }
  });
}

function render(state) {
  const meta = document.getElementById('meta');
  meta.innerHTML = '';
  meta.appendChild(el('div', {}, [
    el('div', {}, [`Status: `, el('span', {class:'badge'}, [state.status || '—'])]),
    el('div', {}, [`KIP UUID: `, el('code', {}, [state.kipUuid || '—'])]),
    el('div', {}, [`Selected display: `, el('code', {}, [state.activeDisplayId ?? 'null'])]),
    el('div', {}, [`Last update: `, el('small', {}, [state.lastUpdated || '—'])]),
    state.errors?.length ? el('div', {class:'err'}, [`Errors: ${state.errors.length} (see console)`]) : el('div')
  ]));

  const cards = document.getElementById('cards');
  cards.innerHTML = '';

  const displays = state.displays || [];
  for (const d of displays) {
    const id = d.id;
    const isActive = id === state.activeDisplayId;
    const dashboards = state.dashboardsByDisplay?.[id] || null;
    const activeDash = state.activeDashboardByDisplay?.[id] ?? 0;
    const dashCount = dashboards ? dashboards.length : 0;

    const card = el('div', {class:'card'}, [
      el('div', {}, [
        el('b', {}, [id]),
        ' ',
        isActive ? el('span', {class:'badge'}, ['selected']) : el('span', {class:'badge'}, [''])
      ]),
      el('div', {}, [el('small', {}, ['Raw: ' + JSON.stringify(d.raw).slice(0, 120) + (JSON.stringify(d.raw).length > 120 ? '…' : '')])]),
      el('hr'),
      el('div', {}, [`Dashboards: `, el('code', {}, [String(dashCount)])]),
      el('div', {}, [`Active dashboard: `, el('code', {}, [String(activeDash)])]),
      el('div', {class:'row'}, [
        el('button', {class:'primary', onclick: async () => {
          await api('./display', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({value:id})});
          await refresh();
        }}, ['Select display']),
        el('button', {onclick: async () => {
          await api('./dashboard', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({displayId:id, index: Math.max(0, activeDash - 1)})});
          await refresh();
        }}, ['Prev dashboard']),
        el('button', {onclick: async () => {
          await api('./dashboard', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({displayId:id, index: activeDash + 1})});
          await refresh();
        }}, ['Next dashboard'])
      ])
    ]);

    cards.appendChild(card);
  }
}

async function refresh() {
  const st = await api('./api/status');
  window.__qxs_state = st;
  render(st);
}

refresh();
refreshConfig();
attachConfigHandlers();
setInterval(refresh, 1500);
