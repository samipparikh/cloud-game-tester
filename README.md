# Cloud Game Tester

A testing tool for measuring cloud gaming quality. Combines an **on-device browser agent** (captures real-time metrics from WebRTC streams) with a **passive network observer** (monitors bandwidth/latency externally).

## Architecture

```
┌─────────────────────────────────────────┐
│ Device running cloud game (browser)     │
│ ┌─────────────────────────────────────┐ │
│ │ On-Device Agent (game-tester-sdk.js)│ │
│ │ - Frame rate / stutter detection    │ │
│ │ - WebRTC stats (resolution, codec)  │ │
│ │ - Gamepad input + latency           │ │
│ │ - Video buffering events            │ │
│ │ - Audio sync / dropouts             │ │
│ │ - Memory / thermal state            │ │
│ └──────────────┬──────────────────────┘ │
└────────────────┼────────────────────────┘
                 │ WebSocket (real-time)
                 ▼
┌─────────────────────────────────────────┐
│ Dashboard Server (server.js)            │
│ - Real-time metric visualization        │
│ - Session recording & history           │
│ - REST API for reports (JSON/CSV)       │
│ - Network observer orchestration        │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│ Passive Network Observer                │
│ - Bandwidth monitoring (in/out Mbps)    │
│ - RTT / ping to game server            │
│ - TCP retransmit / packet loss stats    │
│ - Connection quality over time          │
└─────────────────────────────────────────┘
```

## Metrics Captured

| Category | Metrics |
|----------|---------|
| **Video** | Resolution, frame drops, drop rate, buffering events, codec |
| **Frames** | FPS (avg/min/1% low), frame time, jitter, stutter count |
| **Network** | RTT, jitter, packet loss, bandwidth, NACK/PLI/FIR counts |
| **Input** | Gamepad buttons/axes, keyboard/mouse, input-to-process delay |
| **Audio** | Sample rate, output latency, RMS levels, concealed samples |
| **Device** | Memory usage, battery state, long tasks, thermal events |
| **Stability** | Errors, crashes, connection drops, session duration |

## Quick Start

```bash
cd cloud-game-tester
npm install
npm start
```

Dashboard runs at `http://localhost:3001`

## Usage

### 1. On-Device Agent (inject into browser)

Add this to the page running your cloud game, or paste in DevTools console:

```html
<script src="http://YOUR_SERVER:3001/agent/game-tester-sdk.js"></script>
<script>
const tester = new CloudGameTester({
  wsUrl: 'ws://YOUR_SERVER:3001',
  sampleInterval: 1000
});
tester.start();

// Later: stop and download report
// tester.stop();
// tester.downloadReport();
</script>
```

Or as a bookmarklet:
```javascript
javascript:void((()=>{const s=document.createElement('script');s.src='http://YOUR_SERVER:3001/agent/game-tester-sdk.js';s.onload=()=>{window._cgt=new CloudGameTester({wsUrl:'ws://YOUR_SERVER:3001'}).start()};document.head.appendChild(s)})())
```

### 2. Passive Network Observer

Start via the dashboard UI, or via API:

```bash
curl -X POST http://localhost:3001/api/observer/start \
  -H "Content-Type: application/json" \
  -d '{"targetHost": "streaming.server.com"}'
```

### 3. View Results

- **Real-time**: Dashboard at `http://localhost:3001` shows live FPS, RTT, resolution, input delay
- **API**: `GET /api/sessions/:id/report` returns full JSON report
- **Export**: Click "Export All" in dashboard or call `tester.downloadReport()` on device

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Get session raw data |
| GET | `/api/sessions/:id/report` | Get session summary report |
| POST | `/api/observer/start` | Start network observer |
| POST | `/api/observer/stop` | Stop observer, get report |
| GET | `/api/observer/:id/metrics` | Get observer metrics |

## Output Format (JSON Report)

```json
{
  "session": { "id": "...", "device": {...}, "duration": 120 },
  "summary": {
    "fps": { "avg": 59.2, "min": 42, "p1Low": 38, "stutters": 3 },
    "network": { "avgRtt": 24.5, "packetLoss": 12 },
    "video": { "bufferingEvents": 1, "droppedFrames": 45 },
    "input": { "count": 342, "avgDelay": 3.2, "gamepadEvents": 280 }
  },
  "timeseries": { "frames": [...], "network": [...], "video": [...] }
}
```
