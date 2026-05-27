const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const NetworkObserver = require('./observer/network-observer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'dashboard/public')));
app.use('/agent', express.static(path.join(__dirname, 'agent')));
app.use(express.json());

// Session storage
const sessions = new Map();
const observers = new Map();

// WebSocket - receives real-time metrics from on-device agents
wss.on('connection', (ws) => {
  let sessionId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'session_start') {
        sessionId = msg.session.id;
        sessions.set(sessionId, { session: msg.session, metrics: [], startTime: Date.now() });
        broadcast({ type: 'session_start', session: msg.session });
      }

      if (msg.type === 'metric') {
        const session = sessions.get(msg.sessionId || sessionId);
        if (session) {
          session.metrics.push({ category: msg.category, data: msg.data, timestamp: Date.now() });
        }
        broadcast({ type: 'metric', ...msg });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.endTime = Date.now();
      broadcast({ type: 'session_end', sessionId });
    }
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

// REST API
app.get('/api/sessions', (req, res) => {
  const list = [];
  sessions.forEach((val, id) => {
    list.push({ id, ...val.session, metricsCount: val.metrics.length, startTime: val.startTime, endTime: val.endTime });
  });
  res.json(list.sort((a, b) => b.startTime - a.startTime));
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.get('/api/sessions/:id/report', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const metrics = session.metrics;
  const frames = metrics.filter(m => m.category === 'frames').map(m => m.data);
  const network = metrics.filter(m => m.category === 'network').map(m => m.data);
  const video = metrics.filter(m => m.category === 'video').map(m => m.data);
  const input = metrics.filter(m => m.category === 'input').map(m => m.data);

  res.json({
    session: session.session,
    duration: ((session.endTime || Date.now()) - session.startTime) / 1000,
    summary: {
      fps: {
        avg: frames.length > 0 ? +(frames.reduce((s, f) => s + f.fps, 0) / frames.length).toFixed(1) : null,
        min: frames.length > 0 ? Math.min(...frames.map(f => f.fps)) : null,
        stutters: frames.reduce((s, f) => s + (f.stutterCount || 0), 0)
      },
      network: {
        avgRtt: network.filter(n => n.connection?.rtt).length > 0 ? +(network.filter(n => n.connection?.rtt).reduce((s, n) => s + n.connection.rtt * 1000, 0) / network.filter(n => n.connection?.rtt).length).toFixed(1) : null,
        packetLoss: network.filter(n => n.video).reduce((s, n) => s + (n.video.packetsLost || 0), 0)
      },
      video: {
        bufferingEvents: video.filter(v => v.event === 'buffering').length,
        droppedFrames: video.filter(v => v.droppedFrames).slice(-1)[0]?.droppedFrames || 0
      },
      input: {
        count: input.length,
        avgDelay: input.filter(i => i.inputDelay).length > 0 ? +(input.filter(i => i.inputDelay).reduce((s, i) => s + i.inputDelay, 0) / input.filter(i => i.inputDelay).length).toFixed(2) : null
      }
    },
    timeseries: { frames, network, video, input }
  });
});

// Start network observer
app.post('/api/observer/start', (req, res) => {
  const { id, targetHost, interface: iface } = req.body;
  const observerId = id || `obs_${Date.now()}`;
  const observer = new NetworkObserver({ targetHost, interface: iface });
  observer.start();
  observers.set(observerId, observer);
  res.json({ observerId, status: 'running' });
});

app.post('/api/observer/stop', (req, res) => {
  const { observerId } = req.body;
  const observer = observers.get(observerId);
  if (!observer) return res.status(404).json({ error: 'Observer not found' });
  const report = observer.stop();
  observers.delete(observerId);
  res.json(report);
});

app.get('/api/observer/:id/metrics', (req, res) => {
  const observer = observers.get(req.params.id);
  if (!observer) return res.status(404).json({ error: 'Observer not found' });
  res.json(observer.getReport());
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Cloud Game Tester dashboard: http://localhost:${PORT}`);
  console.log(`Agent SDK available at: http://localhost:${PORT}/agent/game-tester-sdk.js`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});
