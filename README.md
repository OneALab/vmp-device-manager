# VMP Device Manager

Manage NovaStar VMP remembered controllers and projects from a local web UI.

## Features

**Controllers** (`/`) — View, query, and remove remembered controller IPs from VMP's discovery config. Shows live screen info and controller names via the COEX API.

**Projects** (`/projects`) — View and remove VMP project slots. Shows manager.ini associations, screen data, and folder sizes. Creates backups before removal.

**XCenter Service Control** — Start, stop, and restart the XCenter service directly from the UI.

## Requirements

- Windows with [NovaStar VMP](https://www.novastar.tech) installed
- At least one controller must have been connected via VMP
- Run as Administrator (required for XCenter service control)

## Usage

### Option 1: Standalone executable (recommended)

Download or build `VMP-Device-Manager.exe`, then run `VMP-Device-Manager.bat`:

```
VMP-Device-Manager.bat
```

The bat file handles admin elevation and launches the exe.

### Option 2: Run with Node.js

```
node server.js
```

Requires [Node.js](https://nodejs.org) 18+.

### Either way

The app starts a local server on port 3847 and opens your browser to `http://127.0.0.1:3847`.

## Building the standalone exe

```
npm install
npm run build
```

This uses [pkg](https://github.com/vercel/pkg) to bundle Node.js and the app into `dist/VMP-Device-Manager.exe`. No Node.js installation needed on the target machine.

## Project structure

```
server.js              Single-file server with embedded HTML for both UIs
VMP-Device-Manager.bat Launcher with admin elevation and exe/node fallback
package.json           Build configuration
```

## Data locations

| Data | Path |
|------|------|
| Controller IPs (primary) | `C:\ProgramData\XCenter\UserConfig\manualDiscoveryIP.json` |
| Controller IPs (legacy) | `C:\ProgramData\VMP_XCenter\UserConfig\manualDiscoveryIP.json` |
| Projects & manager.ini | `%APPDATA%\VMP\xserver140\` |
| Project backups | `%APPDATA%\VMP\xserver140\_backups\` |
