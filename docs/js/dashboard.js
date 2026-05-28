let tester = null;
let fpsHistory = [];
let frametimeHistory = [];
let totalStutters = 0;
let autoTestRunning = false;

const pageUrl = location.origin + location.pathname.replace(/\/[^/]*$/, '');
const bookmarklet = `javascript:void((()=>{const s=document.createElement('script');s.src='${pageUrl}/agent/game-tester-sdk.js';s.onload=()=>{window._cgt=new CloudGameTester().start();console.log('[CloudGameTester] Running. Call _cgt.stop() then _cgt.downloadReport() when done.')};document.head.appendChild(s)})())`;

document.getElementById('agent-snippet').textContent = bookmarklet;
document.getElementById('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(bookmarklet).then(() => alert('Copied! Paste in DevTools console on your cloud game tab.'));
});

// Start/Stop test
document.getElementById('btn-start-test').addEventListener('click', startTest);
document.getElementById('btn-stop-test').addEventListener('click', stopTest);
document.getElementById('btn-export').addEventListener('click', exportReport);

function startTest() {
  tester = new CloudGameTester({ sampleInterval: 1000 });
  tester.start();
  fpsHistory = [];
  frametimeHistory = [];
  totalStutters = 0;

  document.getElementById('live-section').style.display = 'block';
  document.getElementById('live-session-id').textContent = tester.sessionId;
  document.getElementById('btn-start-test').style.display = 'none';
  document.getElementById('btn-stop-test').style.display = 'inline-block';
  document.getElementById('conn-status').textContent = 'Recording';
  document.getElementById('conn-status').className = 'connection-status connected';

  addEvent('session', 'Test session started');
  addEvent('device', `${navigator.platform} | ${navigator.hardwareConcurrency} cores | ${screen.width}x${screen.height}@${window.devicePixelRatio}x`);

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) addEvent('network', `Connection: ${conn.effectiveType} | ${conn.downlink} Mbps | RTT ~${conn.rtt}ms`);

  startPolling();
}

function stopTest() {
  if (!tester) return;
  const report = tester.stop();
  document.getElementById('btn-start-test').style.display = 'inline-block';
  document.getElementById('btn-stop-test').style.display = 'none';
  document.getElementById('conn-status').textContent = 'Stopped';
  document.getElementById('conn-status').className = 'connection-status disconnected';
  addEvent('session', `Session ended. Duration: ${report.summary.duration.toFixed(1)}s`);
  return report;
}

function exportReport() {
  if (tester) {
    tester.downloadReport();
  } else {
    alert('Start a test session first.');
  }
}

let pollInterval = null;
function startPolling() {
  pollInterval = setInterval(() => {
    if (!tester || !tester.enabled) { clearInterval(pollInterval); return; }

    const frames = tester.metrics.frames;
    const input = tester.metrics.input;
    const network = tester.metrics.network;
    const video = tester.metrics.video;
    const thermal = tester.metrics.thermal;
    const gamepad = tester.metrics.gamepad;

    // FPS
    if (frames.length > 0) {
      const latest = frames[frames.length - 1];
      document.getElementById('live-fps').textContent = latest.fps;
      document.getElementById('live-fps').className = 'metric-value ' + (latest.fps >= 55 ? 'good' : latest.fps >= 30 ? 'warning' : 'bad');
      document.getElementById('live-fps-sub').textContent = `1% low: ${latest.p1Low} | jitter: ${latest.jitter}ms`;
      document.getElementById('live-frametime').textContent = latest.avgFrameTime.toFixed(1);

      fpsHistory.push(latest.fps);
      frametimeHistory.push(latest.avgFrameTime);
      if (fpsHistory.length > 60) fpsHistory.shift();
      if (frametimeHistory.length > 60) frametimeHistory.shift();
      drawChart('chart-fps', fpsHistory, '#4ecdc4', 0, 65);
      drawChart('chart-frametime', frametimeHistory, '#f39c12', 0, 50);

      totalStutters += latest.stutterCount;
      document.getElementById('live-stutter').textContent = totalStutters;
      document.getElementById('live-stutter').className = 'metric-value ' + (totalStutters === 0 ? 'good' : totalStutters < 10 ? 'warning' : 'bad');
    }

    // Input delay
    const recentInput = input.filter(i => i.inputDelay && i.timestamp > Date.now() - 5000);
    if (recentInput.length > 0) {
      const avg = +(recentInput.reduce((s, i) => s + i.inputDelay, 0) / recentInput.length).toFixed(1);
      document.getElementById('live-input-delay').textContent = avg;
      document.getElementById('live-input-delay').className = 'metric-value ' + (avg < 5 ? 'good' : avg < 16 ? 'warning' : 'bad');
    }

    // Network (WebRTC)
    if (network.length > 0) {
      const latest = network[network.length - 1];
      if (latest.connection?.rtt) {
        const rttMs = Math.round(latest.connection.rtt * 1000);
        document.getElementById('live-rtt').textContent = rttMs;
        document.getElementById('live-rtt').className = 'metric-value ' + (rttMs < 30 ? 'good' : rttMs < 80 ? 'warning' : 'bad');
      }
      if (latest.video?.jitter) {
        document.getElementById('live-jitter').textContent = `jitter: ${(latest.video.jitter * 1000).toFixed(1)}ms`;
      }
    } else {
      const conn = navigator.connection;
      if (conn && conn.rtt) {
        document.getElementById('live-rtt').textContent = conn.rtt;
        document.getElementById('live-rtt').className = 'metric-value ' + (conn.rtt < 50 ? 'good' : conn.rtt < 100 ? 'warning' : 'bad');
      }
    }

    // Video
    const videoSamples = video.filter(v => v.width);
    if (videoSamples.length > 0) {
      const latest = videoSamples[videoSamples.length - 1];
      document.getElementById('live-resolution').textContent = `${latest.width}x${latest.height}`;
      document.getElementById('live-bitrate').textContent = `drop rate: ${latest.dropRate || 0}%`;
      document.getElementById('live-drops').textContent = `dropped: ${latest.droppedFrames || 0}`;
    }

    // Memory
    if (thermal.length > 0) {
      const latest = thermal[thermal.length - 1];
      if (latest.memory) {
        document.getElementById('live-memory').textContent = latest.memory.usage;
        document.getElementById('live-memory').className = 'metric-value ' + (latest.memory.usage < 50 ? 'good' : latest.memory.usage < 80 ? 'warning' : 'bad');
      }
    }

    // Gamepad
    const gamepads = navigator.getGamepads();
    let gpConnected = false;
    for (const gp of gamepads) {
      if (gp) { gpConnected = true; document.getElementById('live-gamepad').textContent = '✓'; document.getElementById('live-gamepad').className = 'metric-value good'; document.getElementById('live-gamepad-sub').textContent = gp.id.substring(0, 20); break; }
    }
    if (!gpConnected) { document.getElementById('live-gamepad').textContent = '✗'; document.getElementById('live-gamepad').className = 'metric-value'; document.getElementById('live-gamepad-sub').textContent = 'not connected'; }

  }, 1000);
}

function addEvent(type, message) {
  const list = document.getElementById('events-list');
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'event-entry';
  entry.innerHTML = `<span class="event-time">${time}</span><span class="event-type">${type}</span>${message}`;
  list.prepend(entry);
  if (list.children.length > 50) list.lastChild.remove();
}

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

  ctx.strokeStyle = '#1a1d27';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = (i / 4) * h; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = i * step;
    const y = h - ((Math.min(data[i], max) - min) / range) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const latest = data[data.length - 1];
  ctx.fillStyle = color;
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(latest.toFixed(0), w - 70, 35);
}

// ============ AUTOMATED TEST ============

document.getElementById('dur-minus').addEventListener('click', () => {
  const el = document.getElementById('test-duration');
  el.textContent = Math.max(10, parseInt(el.textContent) - 10);
});
document.getElementById('dur-plus').addEventListener('click', () => {
  const el = document.getElementById('test-duration');
  el.textContent = Math.min(300, parseInt(el.textContent) + 10);
});
document.getElementById('btn-auto-test').addEventListener('click', runAutomatedTest);

function runAutomatedTest() {
  if (autoTestRunning) return;
  autoTestRunning = true;

  const duration = parseInt(document.getElementById('test-duration').textContent);
  const inputType = document.getElementById('input-sim-type').value;
  const stressLevel = document.getElementById('stress-level').value;

  // Start the tester
  if (tester && tester.enabled) tester.stop();
  tester = new CloudGameTester({ sampleInterval: 500 });
  tester.start();
  fpsHistory = [];
  frametimeHistory = [];
  totalStutters = 0;

  document.getElementById('live-section').style.display = 'block';
  document.getElementById('live-session-id').textContent = tester.sessionId + ' (Auto)';
  document.getElementById('btn-auto-test').style.display = 'none';
  document.getElementById('auto-test-progress').style.display = 'block';
  document.getElementById('conn-status').textContent = 'Auto Test';
  document.getElementById('conn-status').className = 'connection-status connected';

  addEvent('auto-test', `Started: ${duration}s, ${inputType} inputs, ${stressLevel} stress`);

  startPolling();

  // Input simulation
  const intervalMs = stressLevel === 'light' ? 500 : stressLevel === 'medium' ? 200 : 80;
  const simInterval = setInterval(() => simulateInput(inputType), intervalMs);

  // Rendering stress (spawn animated elements)
  const stressElements = startRenderStress(stressLevel);

  // Progress timer
  const startTime = Date.now();
  const progressInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const pct = Math.min(100, (elapsed / duration) * 100);
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-text').textContent = `Running... ${Math.floor(elapsed)}s / ${duration}s`;

    if (elapsed >= duration) {
      clearInterval(progressInterval);
      clearInterval(simInterval);
      stopRenderStress(stressElements);
      finishAutoTest(duration, inputType, stressLevel);
    }
  }, 500);
}

function simulateInput(type) {
  const now = performance.now();

  if (type === 'gamepad' || type === 'all') {
    tester.metrics.input.push({
      timestamp: Date.now(), type: 'gamepad_button',
      button: Math.floor(Math.random() * 16), gamepad: 0,
      simulated: true, inputDelay: +(Math.random() * 4 + 1).toFixed(2)
    });
    tester.metrics.input.push({
      timestamp: Date.now(), type: 'gamepad_axis',
      axes: [(Math.random() * 2 - 1).toFixed(3), (Math.random() * 2 - 1).toFixed(3), 0, 0],
      simulated: true
    });
  }

  if (type === 'keyboard' || type === 'all') {
    const keys = ['w', 'a', 's', 'd', 'space', 'shift', 'e', 'r', '1', '2'];
    const key = keys[Math.floor(Math.random() * keys.length)];
    const event = new KeyboardEvent('keydown', { key, bubbles: true });
    document.dispatchEvent(event);
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })), 50 + Math.random() * 100);
  }

  if (type === 'mouse' || type === 'all') {
    const event = new MouseEvent('mousemove', {
      clientX: Math.random() * window.innerWidth,
      clientY: Math.random() * window.innerHeight,
      bubbles: true
    });
    document.dispatchEvent(event);
    if (Math.random() < 0.2) {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      setTimeout(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })), 30);
    }
  }
}

function startRenderStress(level) {
  const count = level === 'light' ? 5 : level === 'medium' ? 15 : 40;
  const container = document.createElement('div');
  container.id = 'stress-container';
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;overflow:hidden;';
  document.body.appendChild(container);

  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    const size = 20 + Math.random() * 60;
    el.style.cssText = `position:absolute;width:${size}px;height:${size}px;border-radius:50%;background:rgba(78,205,196,0.15);top:${Math.random()*100}%;left:${Math.random()*100}%;animation:stressBounce ${1+Math.random()*2}s infinite alternate ease-in-out;`;
    container.appendChild(el);
  }

  if (!document.getElementById('stress-keyframes')) {
    const style = document.createElement('style');
    style.id = 'stress-keyframes';
    style.textContent = '@keyframes stressBounce { from { transform: translate(0,0) scale(1); } to { transform: translate(' + (Math.random()*200-100) + 'px,' + (Math.random()*200-100) + 'px) scale(' + (0.5+Math.random()) + '); } }';
    document.head.appendChild(style);
  }

  return container;
}

function stopRenderStress(container) {
  if (container && container.parentNode) container.parentNode.removeChild(container);
  const style = document.getElementById('stress-keyframes');
  if (style) style.remove();
}

function finishAutoTest(duration, inputType, stressLevel) {
  autoTestRunning = false;
  const report = tester.stop();

  document.getElementById('btn-auto-test').style.display = 'inline-block';
  document.getElementById('auto-test-progress').style.display = 'none';
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('conn-status').textContent = 'Test Complete';
  document.getElementById('conn-status').className = 'connection-status connected';

  addEvent('auto-test', `Complete! ${duration}s, avg FPS: ${report.summary.fps.avg}, stutters: ${report.summary.fps.stutters}`);

  // Auto download report
  const reportData = {
    ...report,
    testConfig: { duration, inputType, stressLevel, automated: true }
  };
  const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `auto-test-${tester.sessionId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
