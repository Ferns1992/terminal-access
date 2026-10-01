/* Browser-driven check. Requires puppeteer-core and a real Chrome.
 *
 *   npm i puppeteer-core
 *   TH_PASS='<admin password>' CHROME_PATH='/path/to/Chrome' node e2e-browser-check.js
 *
 * Verifies what curl-level probes cannot: that the page actually emits
 * connect-ssh and terminal-input, and that the remote host executes them.
 */
/* Instrument the real page: wrap window.io so every socket event is visible,
 * capture toasts, then click a connection and report exactly what arrived.
 *
 * window.io is installed via a property setter because socket.io.js loads
 * after evaluateOnNewDocument, so a plain assignment would be overwritten.
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const BASE = 'https://terminal.sysitadmin.com';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PW = (process.env.TH_PASS || fs.readFileSync('/tmp/browsertest/.pw', 'utf8').trim());

const NAMES = ['connect', 'connect_error', 'terminal-ready', 'terminal-data', 'terminal-error', 'terminal-close', 'monitor-data', 'monitor-error', 'start-monitor', 'connect-ssh'];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // Record every socket event into window.__ev, and every emit into window.__emit.
  await page.evaluateOnNewDocument((names) => {
    window.__ev = [];
    window.__emit = [];
    let real;
    Object.defineProperty(window, 'io', {
      configurable: true,
      get() { return real; },
      set(fn) {
        real = (...a) => {
          const sock = fn(...a);
          for (const n of names) {
            sock.on(n, (d) => {
              let extra = '';
              if (n === 'terminal-data') extra = ` len=${(d && d.data && d.data.length) || 0}`;
              if (n === 'terminal-error') extra = ` err=${d && d.error}`;
              if (n === 'monitor-error') extra = ` err=${d && d.error}`;
              window.__ev.push(`${n}${extra}`);
            });
          }
          const origEmit = sock.emit.bind(sock);
          sock.emit = (ev, ...rest) => { window.__emit.push(ev); return origEmit(ev, ...rest); };
          return sock;
        };
      },
    });
  }, NAMES);

  const errs = [];
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text().slice(0, 200)}`); });

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await page.type('#u', 'admin');
  await page.type('#p', PW);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#submit')]);

  const rows = await page.$$('.conn');
  console.log('--- clicking row 0:', (await page.$eval('.conn-name', (e) => e.textContent)));
  await rows[0].click();
  await new Promise((r) => setTimeout(r, 9000));

  const out = await page.evaluate(() => {
    const host = document.querySelector('.term-host');
    const screen = host ? host.querySelector('.xterm-screen') : null;
    // Strip the injected <style> text so only real terminal glyphs remain.
    let text = '';
    if (screen) {
      const clone = screen.cloneNode(true);
      clone.querySelectorAll('style').forEach((s) => s.remove());
      text = clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 400);
    }
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
    return {
      emitted: window.__emit,
      events: window.__ev.slice(0, 25),
      eventCounts: window.__ev.reduce((a, e) => { const k = e.split(' ')[0]; a[k] = (a[k] || 0) + 1; return a; }, {}),
      rows: host ? host.querySelectorAll('.xterm-rows > div').length : -1,
      screenText: text,
      toasts,
      emptyHidden: document.getElementById('empty').hidden,
    };
  });

  console.log('--- client emits:', JSON.stringify(out.emitted));
  console.log('--- socket events received:', JSON.stringify(out.events));
  console.log('--- counts:', JSON.stringify(out.eventCounts));
  console.log('--- xterm rows:', out.rows, 'empty hidden:', out.emptyHidden);
  console.log('--- terminal text:', JSON.stringify(out.screenText));
  console.log('--- toasts:', JSON.stringify(out.toasts));
  console.log('--- errors:', errs.filter((e) => !/beacon|manifest|inline script/i.test(e)).join('\n') || '(none)');

  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });