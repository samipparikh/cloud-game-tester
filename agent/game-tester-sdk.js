/**
 * CloudGameTester SDK - On-Device Agent
 * Inject this into the browser running the cloud gaming stream.
 * Captures: video quality, audio latency, input latency, gamepad state,
 * network stats (WebRTC), frame metrics, and thermal/device state.
 */
class CloudGameTester {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    this.reportUrl = options.reportUrl || null;
    this.wsUrl = options.wsUrl || null;
    this.sampleInterval = options.sampleInterval || 1000;
    this.enabled = true;

    this.metrics = {
      session: { id: this.sessionId, startTime: Date.now(), device: this.getDeviceInfo() },
      video: [],
      audio: [],
      input: [],
      network: [],
      frames: [],
      gamepad: [],
      thermal: [],
      errors: []
    };

    this._ws = null;
    this._intervals = [];
    this._frameTimestamps = [];
    this._lastFrameTime = 0;
    this._inputEvents = [];
    this._rafId = null;
  }

  // ============ INITIALIZATION ============

  start() {
    console.log(`[CloudGameTester] Session ${this.sessionId} started`);
    this._connectWebSocket();
    this._startFrameMonitor();
    this._startPeriodicSampling();
    this._hookGamepadEvents();
    this._hookInputLatency();
    this._hookMediaElements();
    this._hookWebRTC();
    this._hookErrorCapture();
    return this;
  }

  stop() {
    this.enabled = false;
    this._intervals.forEach(id => clearInterval(id));
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._ws) this._ws.close();
    this.metrics.session.endTime = Date.now();
    this.metrics.session.duration = this.metrics.session.endTime - this.metrics.session.startTime;
    console.log(`[CloudGameTester] Session ended. Duration: ${(this.metrics.session.duration / 1000).toFixed(1)}s`);
    return this.getReport();
  }

  // ============ DEVICE INFO ============

  getDeviceInfo() {
    const nav = navigator;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    return {
      userAgent: nav.userAgent,
      platform: nav.platform,
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory || null,
      screenWidth: screen.width,
      screenHeight: screen.height,
      pixelRatio: window.devicePixelRatio,
      colorDepth: screen.colorDepth,
      connectionType: conn ? conn.effectiveType : null,
      downlink: conn ? conn.downlink : null,
      rtt: conn ? conn.rtt : null,
    };
  }

  // ============ FRAME MONITORING ============

  _startFrameMonitor() {
    let frameCount = 0;
    let lastSecond = performance.now();
    const frameTimes = [];

    const measure = (timestamp) => {
      if (!this.enabled) return;

      if (this._lastFrameTime > 0) {
        const delta = timestamp - this._lastFrameTime;
        frameTimes.push(delta);
      }
      this._lastFrameTime = timestamp;
      frameCount++;

      const elapsed = timestamp - lastSecond;
      if (elapsed >= 1000) {
        const fps = Math.round(frameCount * 1000 / elapsed);
        const sorted = [...frameTimes].sort((a, b) => a - b);
        const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
        const p1Low = sorted.length > 0 ? Math.round(1000 / sorted[Math.floor(sorted.length * 0.99)]) : fps;
        const avgFrameTime = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 16.67;
        const jitter = sorted.length > 1 ? Math.sqrt(sorted.reduce((s, v) => s + Math.pow(v - avgFrameTime, 2), 0) / sorted.length) : 0;

        this.metrics.frames.push({
          timestamp: Date.now(),
          fps,
          p1Low,
          avgFrameTime: +avgFrameTime.toFixed(2),
          p99FrameTime: +p99.toFixed(2),
          jitter: +jitter.toFixed(2),
          stutterCount: frameTimes.filter(t => t > avgFrameTime * 2).length
        });

        frameCount = 0;
        lastSecond = timestamp;
        frameTimes.length = 0;

        this._emit('frames', this.metrics.frames[this.metrics.frames.length - 1]);
      }

      this._rafId = requestAnimationFrame(measure);
    };
    this._rafId = requestAnimationFrame(measure);
  }

  // ============ VIDEO QUALITY ============

  _hookMediaElements() {
    const observe = () => {
      const videos = document.querySelectorAll('video');
      videos.forEach(video => {
        if (video._cgt_hooked) return;
        video._cgt_hooked = true;
        this._monitorVideo(video);
      });
    };

    observe();
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { childList: true, subtree: true });

    this._intervals.push(setInterval(() => {
      const videos = document.querySelectorAll('video');
      videos.forEach(v => this._sampleVideoMetrics(v));
    }, this.sampleInterval));
  }

  _monitorVideo(video) {
    video.addEventListener('waiting', () => this._recordVideoEvent('buffering'));
    video.addEventListener('stalled', () => this._recordVideoEvent('stalled'));
    video.addEventListener('playing', () => this._recordVideoEvent('playing'));
    video.addEventListener('error', (e) => this._recordVideoEvent('error', e.message));
  }

  _sampleVideoMetrics(video) {
    if (!video || video.readyState < 2) return;

    const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const sample = {
      timestamp: Date.now(),
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: +video.currentTime.toFixed(2),
      buffered: video.buffered.length > 0 ? +(video.buffered.end(video.buffered.length - 1) - video.currentTime).toFixed(2) : 0,
      droppedFrames: quality ? quality.droppedVideoFrames : null,
      totalFrames: quality ? quality.totalVideoFrames : null,
      dropRate: quality && quality.totalVideoFrames > 0 ? +(quality.droppedVideoFrames / quality.totalVideoFrames * 100).toFixed(2) : null,
    };

    this.metrics.video.push(sample);
    this._emit('video', sample);
  }

  _recordVideoEvent(type, detail) {
    this.metrics.video.push({ timestamp: Date.now(), event: type, detail });
  }

  // ============ AUDIO LATENCY ============

  _startAudioMonitor() {
    if (!window.AudioContext) return;
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;

      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);

        this._intervals.push(setInterval(() => {
          const data = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteTimeDomainData(data);
          const peak = Math.max(...data);
          const rms = Math.sqrt(data.reduce((s, v) => s + (v - 128) ** 2, 0) / data.length);

          this.metrics.audio.push({
            timestamp: Date.now(),
            peak,
            rms: +rms.toFixed(2),
            sampleRate: ctx.sampleRate,
            latency: ctx.outputLatency || ctx.baseLatency || null
          });
        }, this.sampleInterval));
      }).catch(() => {});
    } catch (e) {}
  }

  // ============ WEBRTC NETWORK STATS ============

  _hookWebRTC() {
    const origPC = window.RTCPeerConnection;
    if (!origPC) return;

    const self = this;
    window.RTCPeerConnection = function(...args) {
      const pc = new origPC(...args);
      self._monitorPeerConnection(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = origPC.prototype;
  }

  _monitorPeerConnection(pc) {
    this._intervals.push(setInterval(async () => {
      if (pc.connectionState === 'closed') return;
      try {
        const stats = await pc.getStats();
        const report = this._parseRTCStats(stats);
        if (report) {
          this.metrics.network.push(report);
          this._emit('network', report);
        }
      } catch (e) {}
    }, this.sampleInterval * 2));
  }

  _parseRTCStats(stats) {
    const report = { timestamp: Date.now() };
    let hasData = false;

    stats.forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        report.video = {
          bytesReceived: s.bytesReceived,
          packetsReceived: s.packetsReceived,
          packetsLost: s.packetsLost || 0,
          framesDecoded: s.framesDecoded,
          framesDropped: s.framesDropped || 0,
          frameWidth: s.frameWidth,
          frameHeight: s.frameHeight,
          framesPerSecond: s.framesPerSecond,
          jitter: s.jitter,
          nackCount: s.nackCount,
          pliCount: s.pliCount,
          firCount: s.firCount,
          decoderImplementation: s.decoderImplementation,
          totalDecodeTime: s.totalDecodeTime,
          totalInterFrameDelay: s.totalInterFrameDelay
        };
        hasData = true;
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        report.audio = {
          bytesReceived: s.bytesReceived,
          packetsReceived: s.packetsReceived,
          packetsLost: s.packetsLost || 0,
          jitter: s.jitter,
          concealedSamples: s.concealedSamples,
          totalSamplesReceived: s.totalSamplesReceived
        };
        hasData = true;
      }
      if (s.type === 'candidate-pair' && s.state === 'succeeded') {
        report.connection = {
          rtt: s.currentRoundTripTime,
          availableOutgoingBitrate: s.availableOutgoingBitrate,
          availableIncomingBitrate: s.availableIncomingBitrate,
          bytesSent: s.bytesSent,
          bytesReceived: s.bytesReceived,
          requestsReceived: s.requestsReceived,
          responsesReceived: s.responsesReceived
        };
        hasData = true;
      }
    });

    return hasData ? report : null;
  }

  // ============ GAMEPAD INPUT ============

  _hookGamepadEvents() {
    window.addEventListener('gamepadconnected', (e) => {
      this.metrics.gamepad.push({
        timestamp: Date.now(),
        event: 'connected',
        id: e.gamepad.id,
        index: e.gamepad.index,
        buttons: e.gamepad.buttons.length,
        axes: e.gamepad.axes.length,
        mapping: e.gamepad.mapping
      });
      this._emit('gamepad', { event: 'connected', id: e.gamepad.id });
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      this.metrics.gamepad.push({ timestamp: Date.now(), event: 'disconnected', id: e.gamepad.id });
    });

    let lastButtonState = {};
    this._intervals.push(setInterval(() => {
      const gamepads = navigator.getGamepads();
      for (const gp of gamepads) {
        if (!gp) continue;
        const key = gp.index;
        const currentButtons = gp.buttons.map(b => b.pressed);
        const prev = lastButtonState[key] || [];

        for (let i = 0; i < currentButtons.length; i++) {
          if (currentButtons[i] && !prev[i]) {
            this._recordInput('gamepad_button', { button: i, gamepad: gp.index, ts: performance.now() });
          }
        }

        const axes = gp.axes.map(a => +a.toFixed(3));
        const hasMovement = axes.some(a => Math.abs(a) > 0.15);
        if (hasMovement) {
          this._recordInput('gamepad_axis', { axes, gamepad: gp.index });
        }

        lastButtonState[key] = [...currentButtons];
      }
    }, 16));
  }

  // ============ INPUT LATENCY ============

  _hookInputLatency() {
    const inputTypes = ['keydown', 'keyup', 'mousedown', 'mouseup', 'touchstart', 'touchend'];
    inputTypes.forEach(type => {
      window.addEventListener(type, (e) => {
        this._recordInput(type, {
          key: e.key || e.button,
          eventTs: e.timeStamp,
          processingTs: performance.now(),
          inputDelay: +(performance.now() - e.timeStamp).toFixed(2)
        });
      }, { passive: true });
    });
  }

  _recordInput(type, data) {
    const entry = { timestamp: Date.now(), type, ...data };
    this.metrics.input.push(entry);
    this._emit('input', entry);
  }

  // ============ THERMAL / DEVICE STATE ============

  _startPeriodicSampling() {
    this._intervals.push(setInterval(() => {
      const entry = { timestamp: Date.now() };

      if (navigator.getBattery) {
        navigator.getBattery().then(battery => {
          entry.battery = { level: battery.level, charging: battery.charging, dischargingTime: battery.dischargingTime };
        });
      }

      if (performance.memory) {
        entry.memory = {
          usedJSHeap: performance.memory.usedJSHeapSize,
          totalJSHeap: performance.memory.totalJSHeapSize,
          limit: performance.memory.jsHeapSizeLimit,
          usage: +(performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit * 100).toFixed(1)
        };
      }

      const longTasks = performance.getEntriesByType('longtask');
      entry.longTasks = longTasks.length;

      this.metrics.thermal.push(entry);
      this._emit('thermal', entry);
    }, this.sampleInterval * 5));
  }

  // ============ ERROR CAPTURE ============

  _hookErrorCapture() {
    window.addEventListener('error', (e) => {
      this.metrics.errors.push({ timestamp: Date.now(), type: 'error', message: e.message, filename: e.filename, line: e.lineno });
    });
    window.addEventListener('unhandledrejection', (e) => {
      this.metrics.errors.push({ timestamp: Date.now(), type: 'unhandledrejection', message: e.reason?.message || String(e.reason) });
    });
  }

  // ============ COMMUNICATION ============

  _connectWebSocket() {
    if (!this.wsUrl) return;
    try {
      this._ws = new WebSocket(this.wsUrl);
      this._ws.onopen = () => {
        this._ws.send(JSON.stringify({ type: 'session_start', session: this.metrics.session }));
      };
      this._ws.onerror = () => {};
      this._ws.onclose = () => { this._ws = null; };
    } catch (e) {}
  }

  _emit(category, data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'metric', category, data, sessionId: this.sessionId }));
    }
  }

  // ============ REPORTING ============

  getReport() {
    const frames = this.metrics.frames;
    const network = this.metrics.network;
    const video = this.metrics.video.filter(v => !v.event);

    return {
      session: this.metrics.session,
      summary: {
        duration: (Date.now() - this.metrics.session.startTime) / 1000,
        fps: {
          avg: frames.length > 0 ? +(frames.reduce((s, f) => s + f.fps, 0) / frames.length).toFixed(1) : null,
          min: frames.length > 0 ? Math.min(...frames.map(f => f.fps)) : null,
          p1Low: frames.length > 0 ? Math.min(...frames.map(f => f.p1Low)) : null,
          stutters: frames.reduce((s, f) => s + f.stutterCount, 0)
        },
        video: {
          resolution: video.length > 0 ? `${video[video.length - 1].width}x${video[video.length - 1].height}` : null,
          droppedFrames: video.length > 0 ? video[video.length - 1].droppedFrames : null,
          dropRate: video.length > 0 ? video[video.length - 1].dropRate : null,
          bufferingEvents: this.metrics.video.filter(v => v.event === 'buffering').length
        },
        network: {
          avgRtt: network.filter(n => n.connection).length > 0 ? +(network.filter(n => n.connection).reduce((s, n) => s + (n.connection.rtt || 0), 0) / network.filter(n => n.connection).length * 1000).toFixed(1) : null,
          packetLoss: network.filter(n => n.video).length > 0 ? network[network.length - 1]?.video?.packetsLost : null,
          jitter: network.filter(n => n.video).length > 0 ? network[network.length - 1]?.video?.jitter : null
        },
        input: {
          totalEvents: this.metrics.input.length,
          avgDelay: this.metrics.input.filter(i => i.inputDelay).length > 0 ? +(this.metrics.input.filter(i => i.inputDelay).reduce((s, i) => s + i.inputDelay, 0) / this.metrics.input.filter(i => i.inputDelay).length).toFixed(2) : null,
          gamepadEvents: this.metrics.input.filter(i => i.type.startsWith('gamepad')).length
        },
        errors: this.metrics.errors.length
      },
      raw: this.metrics
    };
  }

  exportJSON() {
    return JSON.stringify(this.getReport(), null, 2);
  }

  downloadReport() {
    const blob = new Blob([this.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `game-test-${this.sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// Auto-expose globally
if (typeof window !== 'undefined') {
  window.CloudGameTester = CloudGameTester;
}
