// ThatGPT Cloudflare Pages Worker

const FIREBASE_PROJECT_ID = 'hielluo';

// ── Utilities ─────────────────────────────────────────────────────────────────

function b64urlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function b64urlEncode(bytes) {
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlEncodeStr(str) {
  return b64urlEncode(new TextEncoder().encode(str));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function sseResponse(stream) {
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...corsHeaders() },
  });
}

// ── Firebase ──────────────────────────────────────────────────────────────────

async function verifyIdToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('Token expired');
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error('Invalid audience');
  if (!payload.sub) throw new Error('No subject');
  const jwkRes = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const { keys } = await jwkRes.json();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Public key not found');
  const publicKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', publicKey,
    b64urlDecode(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('Invalid signature');
  return payload.sub;
}

async function createCustomToken(uid, serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const headerStr = b64urlEncodeStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadStr = b64urlEncodeStr(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600, uid,
  }));
  const signingInput = `${headerStr}.${payloadStr}`;
  const pemBody = serviceAccount.private_key
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----\n?/, '')
    .replace(/\n?-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ── Streaming ─────────────────────────────────────────────────────────────────

function makeSSEStream(handler) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
  handler(send).catch(e => send({ error: e.message })).finally(() => writer.close());
  return readable;
}

async function streamFromSSE(response, onChunk) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try { await onChunk(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleGetResponse(request, env) {
  const data = await request.json().catch(() => null);
  if (!data?.message?.trim()) return jsonResponse({ error: 'Message required' }, 400);
  const userMessage = data.message.trim();
  const history = data.history || [];
  const messages = [{ role: 'system', content: `You are a helpful assistant. Be clear and direct. Do not cite sources or add references. Today's date is ${new Date().toISOString().slice(0, 10)}.` }];
  for (const msg of (history.slice(0, -1))) {
    messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content });
  }
  messages.push({ role: 'user', content: userMessage });
  const stream = makeSSEStream(async (send) => {
    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.COHERE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'command-r-08-2024', messages, stream: true }),
    });
    if (!res.ok) { await send({ error: await res.text() }); return; }
    await streamFromSSE(res, async (event) => {
      if (event.type === 'content-delta' && event.delta?.message?.content?.text) await send({ chunk: event.delta.message.content.text });
    });
    await send({ done: true });
  });
  return sseResponse(stream);
}

async function handleGetTitle(request) {
  const data = await request.json().catch(() => ({}));
  const message = (data.message || '').trim();
  const title = message.slice(0, 40) + (message.length > 40 ? '…' : '');
  return jsonResponse({ title });
}

async function handleCustomToken(request, env) {
  const body = await request.json().catch(() => null);
  const idToken = body?.idToken;
  if (!idToken) return jsonResponse({ error: 'Missing idToken' }, 400);
  try {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const uid = await verifyIdToken(idToken);
    const customToken = await createCustomToken(uid, sa);
    return jsonResponse({ customToken });
  } catch (e) {
    return jsonResponse({ error: e.message }, 401);
  }
}

// ── Main router ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, origin } = url;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    if (method === 'POST' && pathname === '/get_response') return handleGetResponse(request, env);
    if (method === 'POST' && pathname === '/get_title') return handleGetTitle(request);
    if (method === 'POST' && pathname === '/auth/custom-token') return handleCustomToken(request, env);

    // Clean URL routing
    if (pathname === '/about' || pathname === '/about/') {
      return env.ASSETS.fetch(new Request(`${origin}/about/index.html`, request));
    }

    return env.ASSETS.fetch(request);
  },
};
