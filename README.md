# signalk-qxs001-plugin v0.6.1

This release fixes the startup crash:

- `SyntaxError: Invalid or unexpected token` at `plugin/index.js:1`

Cause: the previous build accidentally introduced a stray leading character at the beginning of JS files.
This build rewrites all JS files as clean UTF-8 without BOM/stray bytes.

## Web UI
The UI pulls key data from the plugin API and display data from the KIP API:

- `/plugins/signalk-qxs001-plugin/api/keys`
- `/plugins/kip/displays`
- `/plugins/kip/displays/<uuid>`
- `/plugins/kip/displays/<uuid>/screenIndex`
- `/plugins/kip/displays/<uuid>/activeScreen`

## KIP integration
Uses:
- GET /plugins/kip/displays - Returns an array of displays, each with a UUID in the id key.
- GET /plugins/kip/displays/<uuid> - Returns the full definition of the display $uuid in terms of an array of dashboards. Each dashboard has a UUID in the id key, name, and icon.
- GET /plugins/kip/displays/<uuid>/screenIndex - Return the current selected dashboard index. The index is consistent in terms of the array of dashboards returned by the /plugins/kip/displays/{$uuid} endpoint.
- POST /plugins/kip/displays/<uuid>/activeScreen body: {"changeId": <uuid>} - Given the display identified by the <uuid>, set as active dashboard the one identified by the UUID given by the changeId parameter.

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
