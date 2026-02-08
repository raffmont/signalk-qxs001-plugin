# Repository Instructions

## Development
- Keep changes focused and documented in the README when behavior or usage changes.
- Prefer clear, user-friendly error messages.
- Use Signal K standards and best practices for plugins and web apps development.
- Add line-by-line pedagogical comments
- Update the markdown documentation if needed.

## KIP integration
When accessing and controlling KIP displays, use the following KIP APIs:
- GET  /plugins/kip/displays
- GET  /plugins/kip/displays/<displayId>
- GET  /plugins/kip/displays/<displayId>/screenIndex
- POST /plugins/kip/displays/<displayId>/activeScreen body: {"changeId": <idx>}


