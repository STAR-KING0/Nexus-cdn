import { Readable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

// Configuration
const CDN_BASE_URL = 'http://fr1.spaceify.eu:25390';
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  try {
    // Parse the incoming URL
    const urlPath = req.url;
    
    // Build target URL - fix for proper path handling
    const targetUrl = new URL(urlPath, CDN_BASE_URL);
    
    console.log(`Proxying: ${req.method} ${req.url} -> ${targetUrl.toString()}`);

    // Prepare headers for the CDN request
    const headers = { ...req.headers };
    
    // Remove hop-by-hop headers
    const hopByHopHeaders = [
      'connection', 'keep-alive', 'proxy-authenticate',
      'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'
    ];
    
    hopByHopHeaders.forEach(header => {
      delete headers[header];
    });

    // Update host header to target
    headers.host = targetUrl.host;

    // Choose the appropriate protocol module
    const protocol = targetUrl.protocol === 'https:' ? https : http;

    // Make request to CDN using native Node.js http/https
    const cdnReq = protocol.request(targetUrl, {
      method: req.method,
      headers: headers
    }, (cdnRes) => {
      // Set response status
      res.statusCode = cdnRes.statusCode;

      // Copy headers from CDN response
      for (const [key, value] of Object.entries(cdnRes.headers)) {
        // Skip certain headers that should be handled by the proxy
        const lowerKey = key.toLowerCase();
        if (!['content-encoding', 'transfer-encoding'].includes(lowerKey)) {
          res.setHeader(key, value);
        }
      }

      // Handle redirects properly
      if (cdnRes.statusCode >= 300 && cdnRes.statusCode < 400 && cdnRes.headers.location) {
        // If it's a redirect from the CDN, we might want to handle it differently
        // For now, just pass it through
        console.log(`Redirect detected: ${cdnRes.headers.location}`);
      }

      // Pipe the response
      cdnRes.pipe(res);

      cdnRes.on('error', (error) => {
        console.error('CDN response error:', error);
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        res.end('CDN response error');
      });
    });

    // Handle CDN request errors
    cdnReq.on('error', (error) => {
      console.error('CDN request error:', error);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 
          error: 'Bad Gateway', 
          message: 'Cannot connect to CDN backend' 
        }));
      }
    });

    // Handle client abort
    req.on('aborted', () => {
      cdnReq.destroy();
    });

    // Pipe the request body for non-GET requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(cdnReq);
    } else {
      cdnReq.end();
    }

  } catch (err) {
    console.error('Proxy error:', err);
    
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ 
        error: 'Proxy failed', 
        message: err.message 
      }));
    }
  }
});

// Error handling
server.on('clientError', (err, socket) => {
  console.error('Client error:', err);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// Start server
server.listen(PORT, () => {
  console.log(`CDN Proxy server running on port ${PORT}`);
  console.log(`Proxying requests to: ${CDN_BASE_URL}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default server;
