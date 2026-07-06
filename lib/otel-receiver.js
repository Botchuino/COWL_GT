// lib/otel-receiver.js
// Opt-in OTLP/HTTP-JSON receiver for Claude Code's OpenTelemetry stream.
//
// The statusline tap stays the real-time heartbeat for the needles; this
// receiver adds the RICH per-turn data the tap can't see — cost, duration,
// effort/speed, cache tokens, compaction effect, structured tool results —
// feeding the "computer di viaggio" strip in the renderer.
//
// Design constraints:
// - OFF by default (config.otel.enabled) — the default install stays fully
//   offline. Even when on, it binds 127.0.0.1 only: nothing leaves the machine.
// - Runs in the MAIN process; the renderer's CSP stays connect-src 'none'.
// - Never trusts the payload: size-capped body, defensive parsing, and a
//   malformed request can only produce a 4xx — never a throw.
//
// Claude Code side (see README "Telemetria ricca"):
//   CLAUDE_CODE_ENABLE_TELEMETRY=1
//   OTEL_LOGS_EXPORTER=otlp
//   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318

const http = require('http');

const MAX_BODY_BYTES = 8 * 1024 * 1024; // OTLP batches are small; this is generous

// --- OTLP JSON decoding --------------------------------------------------------

// OTLP AnyValue -> plain JS value (int64s arrive as strings in OTLP JSON).
function anyValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if (v.kvlistValue && Array.isArray(v.kvlistValue.values)) return kvToObject(v.kvlistValue.values);
  if (v.arrayValue && Array.isArray(v.arrayValue.values)) return v.arrayValue.values.map(anyValue);
  return undefined;
}

function kvToObject(list) {
  const out = {};
  for (const kv of Array.isArray(list) ? list : []) {
    if (kv && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value);
  }
  return out;
}

// Flatten an ExportLogsServiceRequest into [{ name, at, attrs }] events.
// The event name has moved across SDK generations (logRecord.eventName, the
// event.name attribute, or a plain string body) — accept all spellings.
function extractEvents(payload) {
  const events = [];
  if (!payload || typeof payload !== 'object') return events;
  for (const rl of Array.isArray(payload.resourceLogs) ? payload.resourceLogs : []) {
    for (const sl of Array.isArray(rl.scopeLogs) ? rl.scopeLogs : []) {
      for (const rec of Array.isArray(sl.logRecords) ? sl.logRecords : []) {
        if (!rec || typeof rec !== 'object') continue;
        const attrs = kvToObject(rec.attributes);
        const bodyObj = rec.body && rec.body.kvlistValue
          ? kvToObject(rec.body.kvlistValue.values)
          : null;
        const name = rec.eventName || attrs['event.name'] ||
          (rec.body && typeof rec.body.stringValue === 'string' ? rec.body.stringValue : '');
        const tNano = Number(rec.timeUnixNano || rec.observedTimeUnixNano);
        const at = Number.isFinite(tNano) && tNano > 0 ? Math.round(tNano / 1e6) : Date.now();
        events.push({
          name: String(name || ''),
          at,
          // record attributes win over body fields on key collisions
          attrs: Object.assign({}, bodyObj || {}, attrs)
        });
      }
    }
  }
  return events;
}

// --- Server ---------------------------------------------------------------------

// Start the receiver. options: { port } — bind is always 127.0.0.1.
// onEvent(evt) is called for each decoded log event; onStatus(info) (optional)
// reports lifecycle problems like a busy port. Returns { close() }.
function start(options, onEvent, onStatus) {
  const port = Number(options && options.port) || 4318;
  const report = typeof onStatus === 'function' ? onStatus : () => {};

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    // Browsers attach an Origin header to every cross-origin request — even
    // "simple" ones that skip CORS preflight; no local OTLP exporter does.
    // Rejecting them keeps a malicious web page from feeding the trip computer
    // through the visitor's own browser.
    if (req.headers.origin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    const url = String(req.url || '');
    const isLogs = url.startsWith('/v1/logs');
    const known = isLogs || url.startsWith('/v1/metrics') || url.startsWith('/v1/traces');
    if (!known) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    let size = 0;
    const chunks = [];
    let overflow = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        req.destroy();
        return;
      }
      if (isLogs) chunks.push(chunk); // metrics/traces are acknowledged, not parsed
    });
    req.on('error', () => { /* client vanished — nothing to answer */ });
    req.on('end', () => {
      if (overflow) return;
      if (isLogs) {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          for (const evt of extractEvents(payload)) {
            try { onEvent(evt); } catch (_err) { /* consumer errors never kill the server */ }
          }
        } catch (_err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}'); // empty ExportLogsServiceResponse = full success
    });
  });

  server.on('error', (err) => {
    // EADDRINUSE (another collector?) or bind failure: report and stay down —
    // the dashboard keeps working on the statusline tap alone.
    report({ listening: false, port, error: String(err && err.message ? err.message : err) });
  });

  server.listen(port, '127.0.0.1', () => report({ listening: true, port }));

  return {
    close() {
      try { server.close(); } catch (_err) { /* ignore */ }
    }
  };
}

module.exports = { start, extractEvents };
