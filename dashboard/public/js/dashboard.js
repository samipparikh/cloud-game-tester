const wsUrl = `ws://${location.host}`;
let ws = null;
let currentSession = null;
let fpsHistory = [];
let rttHistory = [];
let observerId = null;

// Set agent snippet
const agentSnippet = `<script src="${location.origin}/agent/game-tester-sdk.js"><\/script>\n<script>\nconst tester = new CloudGameTester({ wsUrl: '${wsUrl}' });\ntester.start();\n<\/script>`;
document.getElementById('agent-snippet').textContent = agentSnippet;

function copySnippet() {
  navigator.clipboard.writeText(agentSnippet).then(() => alert('Copied to clipboard!'));
}

// WebSocket connection
function connect() {
  ws = new WebSocket(wsUrl);
  const statusEl = document.getElementById('conn-status');

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'connection-status connected';
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'connection-status disconnected';
    setTimeout(connect, 3000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  if (msg.type === 'session_start') {
    currentSession = msg.session;
    document.getElementById('live-section').style.display = 'block';
    document.getElementById('live-session-id').textContent = msg.session.id;
    fpsHistory = [];
    rttHistory = [];
    addEvent('session', `Session started: ${msg.session.device?.platform || 'Unknown'}`);
  }

  if (msg.type === 'session_end') {
    addEvent('session', 'Session ended');
    loadSessions();
  }

  if (msg.type === 'metric') {
    updateLiveMetric(msg.category, msg.data);
  }
}

function updateLiveMetric(category, data) {
  switch (category) {
    case 'frames':
      document.getElementById('live-fps').textContent = data.fps;
      document.getElementById('live-fps').className = 'metric-value ' + (data.fps >= 55 ? 'good' : data.fps >= 30 ? 'warning' : 'bad');
      document.getElementById('live-fps-sub').textContent = `1% low: ${data.p1Low} | jitter: ${data.jitter}ms`;
      fpsHistory.push(data.fps);
      if (fpsHistory.length > 60) fpsHistory.shift();
      drawChart('chart-fps', fpsHistory, '#4ecdc4', 0, 65);
      break;

    case 'network':
      if (data.connection?.rtt) {
        const rttMs = Math.round(data.connection.rtt * 1000);
        document.getElementById('live-rtt').textContent = rttMs;
        document.getElementById('live-rtt').className = 'metric-value ' + (rttMs < 30 ? 'good' : rttMs < 80 ? 'warning' : 'bad');
        rttHistory.push(rttMs);
        if (rttHistory.length > 60) rttHistory.shift();
        drawChart('chart-rtt', rttHistory, '#f39c12', 0, 150);
      }
      if (data.video) {
        document.getElementById('live-packet-loss').textContent = data.video.packetsLost || 0;
        document.getElementById('live-jitter').textContent = `jitter: ${(data.video.jitter * 1000).toFixed(1)}ms`;
        if (data.video.framesDropped !== undefined) {
          document.getElementById('live-drops').textContent = data.video.framesDropped;
        }
      }
      break;

    case 'video':
      if (data.width && data.height) {
        document.getElementById('live-resolution').textContent = `${data.width}x${data.height}`;
        document.getElementById('live-bitrate').textContent = `drop rate: ${data.dropRate || 0}%`;
      }
      if (data.event) addEvent('video', data.event);
      break;

    case 'input':
      if (data.inputDelay !== undefined) {
        document.getElementById('live-input-delay').textContent = data.inputDelay.toFixed(1);
        document.getElementById('live-input-delay').className = 'metric-value ' + (data.inputDelay < 5 ? 'good' : data.inputDelay < 20 ? 'warning' : 'bad');
      }
      if (data.type === 'gamepad_button') addEvent('input', `Gamepad button ${data.button}`);
      break;

    case 'gamepad':
      addEvent('gamepad', `${data.event}: ${data.id || ''}`);
      break;
  }
}

function addEvent(type, message) {
  const list = document.getElementById('events-list');
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'event-entry';
  entry.innerHTML = `<span class="event-time">${time}</span><span class="event-type">${type}</span>${message}`;
  list.prepend(entry);
  if (list.children.length > 100) list.lastChild.remove();
}

// Simple canvas chart
function drawChart(canvasId, data, color, min, max) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = 300;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0d0f14';
  ctx.fillRect(0, 0, w, h);

  if (data.length < 2) return;

  const range = max - min || 1;
  const step = w / (60 - 1);

  // Grid lines
  ctx.strokeStyle = '#1a1d27';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Data line
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = i * step;
    const y = h - ((data[i] - min) / range) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Latest value label
  const latest = data[data.length - 1];
  ctx.fillStyle = color;
  ctx.font = '24px sans-serif';
  ctx.fillText(latest.toFixed(0), w - 60, 30);
}

// Observer controls
document.getElementById('btn-start-observer').addEventListener('click', async () => {
  const host = document.getElementById('obs-host').value.trim();
  const res = await fetch('/api/observer/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetHost: host || null }) });
  const data = await res.json();
  observerId = data.observerId;
  document.getElementById('observer-status').textContent = `Observer running: ${observerId}`;
  document.getElementById('btn-start-observer').style.display = 'none';
  document.getElementById('btn-stop-observer').style.display = 'inline-block';
});

document.getElementById('btn-stop-observer').addEventListener('click', async () => {
  const res = await fetch('/api/observer/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observerId }) });
  const data = await res.json();
  document.getElementById('observer-status').textContent = `Observer stopped. Avg bandwidth: ${data.summary?.bandwidth?.avgInbound || 0} Mbps in`;
  document.getElementById('btn-start-observer').style.display = 'inline-block';
  document.getElementById('btn-stop-observer').style.display = 'none';
  observerId = null;
});

// Export
document.getElementById('btn-export').addEventListener('click', async () => {
  const res = await fetch('/api/sessions');
  const sessions = await res.json();
  const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'game-test-sessions.json'; a.click();
});

// Load sessions
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    const list = document.getElementById('sessions-list');
    if (sessions.length === 0) { list.innerHTML = '<p class="empty-state">No sessions recorded yet.</p>'; return; }
    list.innerHTML = sessions.map(s => `
      <div class="session-card" onclick="viewSession('${s.id}')">
        <div class="session-info">
          <span class="session-title">${s.id}</span>
          <span class="session-meta">${new Date(s.startTime).toLocaleString()} | ${s.device?.platform || 'Unknown'}</span>
        </div>
        <div class="session-stats">
          <span>${s.metricsCount} metrics</span>
        </div>
      </div>
    `).join('');
  } catch (e) {}
}

async function viewSession(id) {
  const res = await fetch(`/api/sessions/${id}/report`);
  const report = await res.json();
  alert(JSON.stringify(report.summary, null, 2));
}

connect();
loadSessions();
