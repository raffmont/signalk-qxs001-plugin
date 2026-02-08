# signalk-qxs001-plugin v0.6.1

This release fixes the startup crash:

- `SyntaxError: Invalid or unexpected token` at `plugin/index.js:1`

Cause: the previous build accidentally introduced a stray leading character at the beginning of JS files.
This build rewrites all JS files as clean UTF-8 without BOM/stray bytes.

## Web UI
The UI calls the correct base:

- `/plugins/signalk-qxs001-plugin/api/keys`
- `/plugins/signalk-qxs001-plugin/api/state`

## KIP integration
Uses:
- `GET  /plugins/kip/displays`
- `GET  /plugins/kip/displays/<displayId>`
- `GET  /plugins/kip/displays/<displayId>/screenIndex`
- `POST /plugins/kip/displays/<displayId>/activeScreen` body: `{"changeId": <idx>}`

## Settings: Play bindings
In plugin configuration: `playBindings[]`

Each item:
1) `screenId` (KIP displayId)
2) `dashboardId` (KIP dashboard id)
3) action:
   - REST: `actionType: "rest"`, plus `url`, `method`, `params`, `body`
   - Signal K write: `actionType: "signalk"`, plus `key`, `value`

## Non-root
Make sure the Signal K user is in group `input`:

```bash
sudo usermod -aG input $USER
# logout/login
id
```
