# AGENTS Instructions

When accessing and controlling KIP displays, use the following KIP APIs:
- GET  /plugins/kip/displays
- GET  /plugins/kip/displays/<displayId>
- GET  /plugins/kip/displays/<displayId>/screenIndex
- POST /plugins/kip/displays/<displayId>/activeScreen body: {"changeId": <idx>}
