const https = require('https');
const http = require('http');
const { URL } = require('url');

function rewriteHtml(body, originalHost) {
  if (!body) return body;
  let result = body;
  result = result.replace(new RegExp('https?://' + originalHost.replace(/\./g, '\\.'), 'gi'), '/p/' + originalHost);
  result = result.replace(/\/\/([a-z0-9][a-z0-9.-]+\.[a-z]{2,})\//gi, (match, domain) => {
    if (match.startsWith('//p/')) return match;
    return '/p/' + domain + '/';
  });
  result = result.replace(/(src|href|action|data-src|data-href)\s*=\s*["']\/(?!p\/)/gi, '$1="/p/' + originalHost + '/');
  result = result.replace(/url\(\s*["']?\/(?!p\/)/gi, 'url(/p/' + originalHost + '/');
  return result;
}

function doRequest(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const reqHeaders = { ...headers };
    delete reqHeaders.host;
    delete reqHeaders['content-length'];
    reqHeaders['accept-encoding'] = 'identity'; // 防止 gzip 乱码

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );

    req.on('error', (e) => reject(e));
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));

    if (body && !['GET', 'HEAD'].includes(method)) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function isTextType(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('text/css') || ct.includes('javascript') || ct.includes('application/json') || ct.includes('text/plain');
}

export default async function handler(req, res) {
  let host = '';
  try {
    const fullUrl = `https://${req.headers.host}${req.url}`;
    const parsed = new URL(fullUrl);
    let pathname = parsed.pathname;

    let remaining = pathname.startsWith('/p/') ? pathname.slice(3) : pathname.replace(/^\//, '');
    const slash = remaining.indexOf('/');
    host = slash === -1 ? remaining : remaining.slice(0, slash);

    if (!host) {
      return res.status(400).json({ error: 'No host specified' });
    }

    let pathPart = slash === -1 ? '/' : remaining.slice(slash);
    const targetUrl = `https://${host}${pathPart}${parsed.search}`;

    const result = await doRequest(targetUrl, req.method, req.headers, req.body);

    const contentType = result.headers['content-type'] || '';
    const isText = isTextType(contentType);

    // 复制响应头
    for (const [k, v] of Object.entries(result.headers)) {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }

    if (isText) {
      let textBody = result.body.toString('utf-8');
      textBody = rewriteHtml(textBody, host);
      return res.status(result.statusCode).send(textBody);
    } else {
      // Vercel 可以直接发送二进制 Buffer（图片等）
      return res.status(result.statusCode).send(result.body);
    }

  } catch (error) {
    return res.status(502).json({ error: error.message, target: host });
  }
}