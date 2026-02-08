# Repository Instructions

## Development
- Keep changes focused and documented in the README when behavior or usage changes.
- Prefer clear, user-friendly error messages.
- Use Signal K standards and best practices for plugins and web apps development.
- Add line-by-line pedagogical comments
- Update the markdown documentation if needed.

## KIP integration
When accessing and controlling KIP displays, use the following KIP APIs:
- GET /plugins/kip/displays - Returns an array of displays, each with a UUID in the id key.
- GET /plugins/kip/displays/<uuid> - Returns the full definition of the display $uuid in terms of an array of dashboards. Each dashboard has a UUID in the id key, name, and icon.
- GET /plugins/kip/displays/<uuid>/screenIndex - Return the current selected dashboard index. The index is consistent in terms of the array of dashboards returned by the /plugins/kip/displays/{$uuid} endpoint.
- POST /plugins/kip/displays/<uuid>/activeScreen body: {"changeId": <uuid>} - Given the display identified by the <uuid>, set as active dashboard the one identified by the UUID given by the changeId parameter.


