# signalk-qxs-plugin

A Signal K server plugin for Raspberry Pi that listens to a Bluetooth‑paired **QXS** remote control (HID keyboard)
and maps:

- **Volume Up / Volume Down** → select the active **KIP display**
- **Next / Previous** → switch **dashboards** (screens) of the currently selected display

It exposes:
- A REST property-like endpoint **`/plugins/qxs/display`** (GET/PUT) to store the active display id
- A tiny web UI (served by the plugin) to show available displays and current dashboard per display

## Requirements

- Signal K server (Node.js 20+ recommended)
- KIP plugin installed and running (this plugin depends on it)
- QXS remote paired and connected over Bluetooth
- Permission to read `/dev/input/event*` (run Signal K as root, or give access via udev/group)

## Install (typical)

From Signal K server UI:
1. Server → Appstore → search `signalk-qxs-plugin` (if published) or install from a folder
2. Configure the plugin (optional): set the input device path or leave auto-detect

Or from a local folder:
```bash
cd ~/.signalk/node_modules
git clone https://github.com/raffmont/signalk-qxs-plugin.git
cd signalk-qxs-plugin
npm install --production
sudo systemctl restart signalk
```

## Configuration

- **devicePath** (optional): `/dev/input/eventX` to force the device
- **autodetectSeconds**: sniff window used to pick the event device (default 6)
- **kipUuid** (optional): if you know KIP UUID, set it; otherwise the plugin will infer it from KIP displays list
- **httpToken** (optional): Signal K JWT token if your server requires auth for local API calls

## How it works

- Fetches available displays via `GET /plugins/kip/displays`
- Keeps an internal model:
  - displays list
  - current selected display id (persisted via plugin endpoint `/plugins/qxs/display`)
  - dashboards array for each display (read from `self.displays.<KIP_UUID>.screenIndex` when available)
- To change dashboard, it writes to `self.displays.<KIP_UUID>.activeScreen` (KIP reacts)

## Web UI

Open:
`http://<signalk-host>:3000/plugins/signalk-qxs-plugin/`

You will see:
- available displays
- current selected display
- dashboards count and current active dashboard per display

## Notes

Key codes vary across remotes/OS. Defaults follow common Linux HID mappings:
- VOL UP: 115, VOL DOWN: 114
- NEXT: 163, PREV: 165

You can override key codes in `index.js` constants if needed.

