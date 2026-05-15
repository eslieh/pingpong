const DEV_ORIGIN_PATTERNS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGINS || '';
  const list = raw.split(',').map((entry) => entry.trim()).filter(Boolean);

  if (process.env.ALLOW_DEV_ORIGINS === '1') {
    for (const origin of DEV_ORIGIN_PATTERNS) {
      if (!list.includes(origin)) list.push(origin);
    }
  }

  return list;
}

function isLocalDevOrigin(origin) {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function matchOrigin(origin, pattern) {
  if (pattern === '*') return true;
  if (origin === pattern) return true;

  if (pattern.startsWith('*.')) {
    try {
      const url = new URL(origin);
      const suffix = pattern.slice(1);
      return url.host.endsWith(suffix) || url.host === suffix.slice(1);
    } catch {
      return false;
    }
  }

  return false;
}

function isOriginAllowed(origin) {
  if (!origin) return true;

  if (process.env.NODE_ENV !== 'production' && isLocalDevOrigin(origin)) {
    return true;
  }

  const allowed = parseAllowedOrigins();
  if (allowed.length > 0) {
    return allowed.some((pattern) => matchOrigin(origin, pattern));
  }

  return false;
}

function describeOriginRejection(origin) {
  const allowed = parseAllowedOrigins();
  if (!origin) {
    return 'missing Origin header (Postman omits this; browsers always send it)';
  }
  if (allowed.length === 0) {
    return 'ALLOWED_ORIGINS is empty on the server';
  }
  return `add "${origin}" to ALLOWED_ORIGINS on the VPS (current: ${allowed.join(', ')})`;
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function handlePreflight(req, res) {
  applyCorsHeaders(req, res);
  res.writeHead(204);
  res.end();
}

function getClientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }

  return req.socket.remoteAddress;
}

module.exports = {
  parseAllowedOrigins,
  isOriginAllowed,
  describeOriginRejection,
  applyCorsHeaders,
  handlePreflight,
  getClientIp,
};
