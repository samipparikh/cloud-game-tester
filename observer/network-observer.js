/**
 * Passive Network Observer
 * Monitors network traffic characteristics for cloud gaming sessions.
 * Runs as a sidecar or proxy capturing packet-level metrics.
 */
const { exec } = require('child_process');

class NetworkObserver {
  constructor(options = {}) {
    this.interface = options.interface || 'en0';
    this.targetHost = options.targetHost || null;
    this.sampleInterval = options.sampleInterval || 1000;
    this.metrics = [];
    this._intervals = [];
    this._running = false;
  }

  start() {
    this._running = true;
    console.log(`[NetworkObserver] Monitoring interface: ${this.interface}`);
    this._startBandwidthMonitor();
    this._startLatencyMonitor();
    this._startConnectionQuality();
    return this;
  }

  stop() {
    this._running = false;
    this._intervals.forEach(id => clearInterval(id));
    return this.getReport();
  }

  _startBandwidthMonitor() {
    let prevBytes = null;

    this._intervals.push(setInterval(() => {
      exec(`netstat -ib -I ${this.interface} | tail -1`, (err, stdout) => {
        if (err) return;
        const parts = stdout.trim().split(/\s+/);
        if (parts.length < 10) return;

        const bytesIn = parseInt(parts[6]) || 0;
        const bytesOut = parseInt(parts[9]) || 0;

        if (prevBytes) {
          const deltaIn = bytesIn - prevBytes.in;
          const deltaOut = bytesOut - prevBytes.out;
          const mbpsIn = +(deltaIn * 8 / 1000000).toFixed(2);
          const mbpsOut = +(deltaOut * 8 / 1000000).toFixed(2);

          this.metrics.push({
            timestamp: Date.now(),
            type: 'bandwidth',
            inboundMbps: mbpsIn,
            outboundMbps: mbpsOut,
            totalMbps: +(mbpsIn + mbpsOut).toFixed(2)
          });
        }
        prevBytes = { in: bytesIn, out: bytesOut };
      });
    }, this.sampleInterval));
  }

  _startLatencyMonitor() {
    if (!this.targetHost) return;

    this._intervals.push(setInterval(() => {
      exec(`ping -c 1 -W 1 ${this.targetHost}`, (err, stdout) => {
        const match = stdout?.match(/time[=<](\d+\.?\d*)/);
        if (match) {
          this.metrics.push({
            timestamp: Date.now(),
            type: 'latency',
            rttMs: parseFloat(match[1]),
            host: this.targetHost
          });
        } else {
          this.metrics.push({
            timestamp: Date.now(),
            type: 'latency',
            rttMs: null,
            timeout: true,
            host: this.targetHost
          });
        }
      });
    }, this.sampleInterval * 2));
  }

  _startConnectionQuality() {
    this._intervals.push(setInterval(() => {
      exec(`netstat -s | grep -E "(packets received|packets sent|retransmit|out of order)"`, (err, stdout) => {
        if (err) return;
        const lines = stdout.trim().split('\n');
        const stats = {};
        lines.forEach(line => {
          const match = line.trim().match(/^(\d+)\s+(.+)/);
          if (match) {
            const key = match[2].trim().replace(/\s+/g, '_').toLowerCase();
            stats[key] = parseInt(match[1]);
          }
        });
        if (Object.keys(stats).length > 0) {
          this.metrics.push({ timestamp: Date.now(), type: 'tcp_stats', ...stats });
        }
      });
    }, this.sampleInterval * 5));
  }

  getReport() {
    const bandwidth = this.metrics.filter(m => m.type === 'bandwidth');
    const latency = this.metrics.filter(m => m.type === 'latency');

    return {
      summary: {
        bandwidth: {
          avgInbound: bandwidth.length > 0 ? +(bandwidth.reduce((s, b) => s + b.inboundMbps, 0) / bandwidth.length).toFixed(2) : null,
          peakInbound: bandwidth.length > 0 ? Math.max(...bandwidth.map(b => b.inboundMbps)) : null,
          avgOutbound: bandwidth.length > 0 ? +(bandwidth.reduce((s, b) => s + b.outboundMbps, 0) / bandwidth.length).toFixed(2) : null,
        },
        latency: {
          avg: latency.filter(l => l.rttMs).length > 0 ? +(latency.filter(l => l.rttMs).reduce((s, l) => s + l.rttMs, 0) / latency.filter(l => l.rttMs).length).toFixed(1) : null,
          min: latency.filter(l => l.rttMs).length > 0 ? Math.min(...latency.filter(l => l.rttMs).map(l => l.rttMs)) : null,
          max: latency.filter(l => l.rttMs).length > 0 ? Math.max(...latency.filter(l => l.rttMs).map(l => l.rttMs)) : null,
          packetLoss: latency.length > 0 ? +(latency.filter(l => l.timeout).length / latency.length * 100).toFixed(1) : null
        },
        samples: this.metrics.length
      },
      raw: this.metrics
    };
  }
}

module.exports = NetworkObserver;
