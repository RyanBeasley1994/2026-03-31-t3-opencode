/**
 * Returns a self-contained HTML document string for the connection mode picker.
 * Rendered directly into the BrowserWindow before the main app loads.
 */
export function connectionScreenHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>T3 Code</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #0a0a0b;
    color: #e4e4e7;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    -webkit-font-smoothing: antialiased;
  }
  .drag-region {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 52px;
    -webkit-app-region: drag;
  }
  h1 {
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 8px;
    color: #fafafa;
  }
  .subtitle {
    font-size: 14px;
    color: #71717a;
    margin-bottom: 32px;
  }
  .cards {
    display: flex;
    gap: 16px;
  }
  .card {
    width: 240px;
    padding: 24px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 12px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    -webkit-app-region: no-drag;
  }
  .card:hover {
    border-color: #3f3f46;
    background: #1c1c1f;
  }
  .card.selected {
    border-color: #a78bfa;
    background: #1c1c1f;
  }
  .card-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 6px;
    color: #fafafa;
  }
  .card-desc {
    font-size: 13px;
    color: #71717a;
    line-height: 1.5;
  }
  .server-form {
    display: none;
    margin-top: 24px;
    width: 496px;
  }
  .server-form.visible { display: flex; flex-direction: column; gap: 8px; }
  .server-form .row { display: flex; gap: 8px; }
  .server-form input {
    flex: 1;
    padding: 10px 14px;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 8px;
    color: #e4e4e7;
    font-size: 14px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }
  .server-form input:focus { border-color: #a78bfa; }
  .server-form input::placeholder { color: #52525b; }
  .connect-btn {
    padding: 10px 20px;
    background: #a78bfa;
    color: #0a0a0b;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .connect-btn:hover { opacity: 0.9; }
  .connect-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .error {
    color: #f87171;
    font-size: 13px;
    margin-top: 8px;
    display: none;
    width: 496px;
  }
  .error.visible { display: block; }
</style>
</head>
<body>
  <div class="drag-region"></div>
  <h1>T3 Code</h1>
  <p class="subtitle">How do you want to run T3 Code?</p>
  <div class="cards">
    <div class="card" id="card-local" onclick="selectLocal()">
      <div class="card-title">Local</div>
      <div class="card-desc">Run the server on this machine. Everything stays local.</div>
    </div>
    <div class="card" id="card-server" onclick="selectServer()">
      <div class="card-title">Server</div>
      <div class="card-desc">Connect to a remote T3 Code server.</div>
    </div>
  </div>
  <div class="server-form" id="server-form">
    <div class="row">
      <input type="url" id="server-url" placeholder="https://your-server.example.com" autofocus />
    </div>
    <div class="row">
      <input type="password" id="server-token" placeholder="Auth token (optional)" />
      <button class="connect-btn" id="test-btn" onclick="testConnection()" style="background:transparent;border:1px solid #27272a;color:#e4e4e7;">Test</button>
      <button class="connect-btn" id="connect-btn" onclick="connectToServer()">Connect</button>
    </div>
  </div>
  <div class="error" id="error-msg"></div>
  <script>
    function selectLocal() {
      document.getElementById('card-local').classList.add('selected');
      document.getElementById('card-server').classList.remove('selected');
      document.getElementById('server-form').classList.remove('visible');
      document.getElementById('error-msg').classList.remove('visible');
      window.desktopBridge.saveConnectionConfig({ mode: 'local', serverUrl: null, authToken: null });
    }
    function selectServer() {
      document.getElementById('card-server').classList.add('selected');
      document.getElementById('card-local').classList.remove('selected');
      document.getElementById('server-form').classList.add('visible');
      document.getElementById('server-url').focus();
    }
    function getServerInputs() {
      var url = document.getElementById('server-url').value.trim();
      var token = document.getElementById('server-token').value.trim();
      return { url: url, token: token || null };
    }
    function validateUrl(url) {
      return url.startsWith('http://') || url.startsWith('https://');
    }
    function testConnection() {
      var inputs = getServerInputs();
      var errorEl = document.getElementById('error-msg');
      var testBtn = document.getElementById('test-btn');
      if (!validateUrl(inputs.url)) {
        errorEl.textContent = 'URL must start with http:// or https://';
        errorEl.classList.add('visible');
        return;
      }
      errorEl.classList.remove('visible');
      testBtn.textContent = 'Testing...';
      testBtn.disabled = true;
      var wsProto = inputs.url.startsWith('https://') ? 'wss://' : 'ws://';
      var parsed = new URL(inputs.url);
      var wsUrl = wsProto + parsed.host + '/ws';
      if (inputs.token) wsUrl += '?token=' + encodeURIComponent(inputs.token);
      var ws = new WebSocket(wsUrl);
      var timeout = setTimeout(function() {
        ws.close();
        errorEl.textContent = 'Connection timed out';
        errorEl.classList.add('visible');
        testBtn.textContent = 'Test';
        testBtn.disabled = false;
      }, 5000);
      ws.onopen = function() {
        clearTimeout(timeout);
        ws.close();
        errorEl.textContent = '';
        errorEl.classList.remove('visible');
        testBtn.textContent = 'Connected!';
        testBtn.style.borderColor = '#4ade80';
        testBtn.style.color = '#4ade80';
        setTimeout(function() {
          testBtn.textContent = 'Test';
          testBtn.style.borderColor = '';
          testBtn.style.color = '';
          testBtn.disabled = false;
        }, 2000);
      };
      ws.onerror = function() {
        clearTimeout(timeout);
        errorEl.textContent = 'Connection failed — check URL and token';
        errorEl.classList.add('visible');
        testBtn.textContent = 'Test';
        testBtn.disabled = false;
      };
    }
    function connectToServer() {
      var inputs = getServerInputs();
      var errorEl = document.getElementById('error-msg');
      if (!validateUrl(inputs.url)) {
        errorEl.textContent = 'URL must start with http:// or https://';
        errorEl.classList.add('visible');
        return;
      }
      errorEl.classList.remove('visible');
      window.desktopBridge.saveConnectionConfig({ mode: 'server', serverUrl: inputs.url, authToken: inputs.token });
    }
    document.getElementById('server-url').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') document.getElementById('server-token').focus();
    });
    document.getElementById('server-token').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') connectToServer();
    });
  </script>
</body>
</html>`;
}
