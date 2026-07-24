// OTLP span tree builder. Spec explicitly allows hex trace/span IDs (not base64),
// so we emit them as plain hex strings.

const { newSpanId, nowNanos } = require('./util');

const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3 };
const STATUS = { UNSET: 0, OK: 1, ERROR: 2 };

function attr(key, val) {
  if (typeof val === 'number' && Number.isInteger(val)) return { key, value: { intValue: val } };
  if (typeof val === 'number') return { key, value: { doubleValue: val } };
  if (typeof val === 'boolean') return { key, value: { boolValue: val } };
  return { key, value: { stringValue: String(val) } };
}

// Creates a span record, registers it in run.spans + run.spanIndex[role], returns it.
function addSpan(run, { role, parentSpanId, name, kind, attributes = {}, start, links = [] }) {
  const spanId = newSpanId();
  const rec = {
    role,
    spanId,
    parentSpanId: parentSpanId || null,
    name,
    kind,
    start: start || nowNanos(),
    end: null,
    attributes: {
      'ga5.run.id': run.runId,
      'ga5.public.marker': run.publicMarker,
      ...attributes,
    },
    status: { code: STATUS.UNSET },
    links,
  };
  run.spans.push(rec);
  run.spanIndex[role] = rec;
  return rec;
}

function closeSpan(rec, { end, code, message } = {}) {
  if (!rec) return;
  rec.end = end || nowNanos();
  if (code !== undefined) rec.status = { code, ...(message ? { message } : {}) };
}

function buildOtlp(run) {
  const spans = run.spans.map(s => ({
    traceId: run.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: s.kind,
    startTimeUnixNano: s.start,
    endTimeUnixNano: s.end || s.start,
    attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
    status: s.status,
    ...(s.links.length ? { links: s.links.map(l => ({ traceId: run.traceId, spanId: l })) } : {}),
  }));

  return {
    resourceSpans: [{
      resource: { attributes: [attr('service.name', run.agentName || 'incident-response')] },
      scopeSpans: [{
        scope: { name: 'incident-agent', version: '1.0.0' },
        spans,
      }],
    }],
  };
}

module.exports = { KIND, STATUS, addSpan, closeSpan, buildOtlp };
