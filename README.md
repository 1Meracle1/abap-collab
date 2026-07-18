# ABAP Collaborate

ABAP Collaborate is the browser MVP for sharing and editing ABAP code in a
VS Code-style interface. Opening `/` creates a room URL. Anyone opening that
URL joins the same Yjs workspace and can see live participants, selections,
files, folders, and edits. The Explorer creates and manages shared files and
nested folders. Its action menu and common keyboard shortcuts support
multi-selection, rename, copy, cut/move, paste, and recursive deletion.
Rooms created by the earlier single-file client are migrated to `report.abap`
by either the Worker or the browser, so a frontend deployment does not require
an exactly simultaneous Worker restart.

The ABAP and ABAP CDS language registrations are not copied browser grammars.
The build uses a pinned release of `1Meracle1/abap-language-basics`, keeping the
browser and VSIX behavior on the same ABAP, AMDP SQLScript, and CDS grammar
source files.

The editor uses VS Code's built-in **Dark+** and **Light+** code themes. The site
chrome continues to follow the matching dark or light application theme.

## Run Locally

Use Node.js 22.12 or newer:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:4173`. Use **Share room** or copy the resulting
`/room/<id>` URL into another browser tab.

Useful commands:

```sh
npm run build    # type-check and create dist/
npm test         # two-client WebSocket synchronization test
npm run preview  # preview the Worker and production bundle
```

Local development runs the same Worker and Durable Object architecture used in
production. Room documents are stored in local Wrangler state while developing.

## Architecture

- `src/main.ts` initializes Monaco with VS Code language, TextMate, theme,
  configuration, file, and snippet services.
- `src/abap-extension.ts` registers `abap-language-basics` as a declarative
  browser extension and maps its ABAP and CDS grammars, configurations, and
  snippets into the extension host.
- `src/room-workspace.ts` owns the collaborative file tree, Explorer UI, Monaco
  models, and the active `y-monaco` binding.
- Yjs maps store room file paths, folder paths, and one shared text type per
  file.
- `worker/index.js` routes room WebSockets to one Durable Object per room and
  persists each Yjs document in Durable Object storage.
- Cloudflare's WebSocket Hibernation API keeps idle room connections open
  without keeping a Worker instance active.
- Yjs awareness carries participant names, colors, cursors, and selections.

## MVP Boundary

Room URLs currently grant edit access. There is no authentication, private-room
authorization, rate limiting, room expiration, or deployment hardening, so the
server should not be exposed directly to the public internet yet.

This version integrates the declarative ABAP Language Basics extension. It does
not yet connect the Odin `abap_language_server`; diagnostics, navigation,
semantic tokens, and context-aware completion require a WebSocket-to-stdio LSP
gateway in the next milestone.

## Deploy to Cloudflare

Authenticate Wrangler once and deploy the Worker, Durable Object, and static
assets together:

```sh
npx wrangler login
npm run deploy
```

The `v1` migration creates the SQLite-backed `CollaborationRoom` Durable Object
class. The Worker routes `/collaboration/<room-id>` before static assets and
serves all other paths from `dist/`, including SPA room URLs.

The deployment is intentionally an anonymous public preview. Anyone with a room
URL can read and edit that room. Do not use it for sensitive ABAP source.
