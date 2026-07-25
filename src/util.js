const crypto = require('crypto');

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hashOfObject(obj) {
  return sha256Hex(stableStringify(obj));
}

function argumentsDigest(args) {
  return sha256Hex(stableStringify(args || {}));
}

function hexId(bytes = 8) {
  let id;
  do {
    id = crypto.randomBytes(bytes).toString('hex');
  } while (/^0+$/.test(id));
  return id;
}

const newTraceId = () => hexId(16); // 32 hex chars
const newSpanId = () => hexId(8);   // 16 hex chars

function parseTraceparent(header) {
  if (!header || typeof header !== 'string') return null;
  const m = header.trim().match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { version, traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase(), flags };
}

const buildTraceparent = (traceId, spanId, flags = '01') => `00-${traceId}-${spanId}-${flags}`;

let counter = 0n;
function nowNanos() {
  counter += 1n;
  return (BigInt(Date.now()) * 1000000n + (counter % 1000n)).toString();
}

const uuid = () => crypto.randomUUID();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  stableStringify, sha256Hex, hashOfObject, argumentsDigest,
  hexId, newTraceId, newSpanId, parseTraceparent, buildTraceparent,
  nowNanos, uuid, HttpError,
};
