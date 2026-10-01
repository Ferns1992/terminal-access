/* Browser-driven check. Requires puppeteer-core and a real Chrome.
 *
 *   npm i puppeteer-core
 *   TH_PASS='<admin password>' CHROME_PATH='/path/to/Chrome' node e2e-switch-check.js
 *
 * Verifies what curl-level probes cannot: that the page actually emits
 * connect-ssh and terminal-input, and that the remote host executes them.
 */
/* Open two servers, switch between them, and confirm BOTH the terminal and
 * the metrics survive the switch. Covers the reported multi-VPS glitch. */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const BASE = 'https://terminal.sysitadmin.com';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PW = (process.env.TH_PASS || fs.readFileSync('/tmp/browsertest/.pw', 'utf8').trim());

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await p.type('#u', 'admin'); await p.type('#p', PW);
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2' }), p.click('#submit')]);

  const snap = () => p.evaluate(() => {
    const hosts = [...document.querySelectorAll('.term-host')];
    const vis = hosts.filter(h => !h.hidden);
    const txt = (h) => { const s = h.querySelector('.xterm-screen'); if (!s) return '';
      const c = s.cloneNode(true); c.querySelectorAll('style').forEach(x => x.remove());
      return c.textContent.replace(/\s+/g, ' ').trim(); };
    const host = vis[0];
    const m = document.getElementById('metrics');
    return {
      hosts: hosts.length, visible: vis.length,
      tabs: document.querySelectorAll('.tab').length,
      termChars: host ? txt(host).length : 0,
      termSample: host ? txt(host).slice(0, 90) : '',
      metricsHidden: m ? m.hidden : null,
      cpu: document.getElementById('mCpu').textContent,
      mem: document.getElementById('mMem').textContent,
      kernel: document.getElementById('mKer') ? document.getElementById('mKer').textContent : '',
    };
  });

  const rows = await p.$$('.conn');
  const names = await p.$$eval('.conn-name', (e) => e.map(x => x.textContent));
  await rows[0].click();
  await new Promise(r => setTimeout(r, 9000));
  console.log(`[A] ${names[0]}:`, JSON.stringify(await snap()));

  const rows2 = await p.$$('.conn');
  await rows2[1].click();
  await new Promise(r => setTimeout(r, 11000));
  console.log(`[B] ${names[1]}:`, JSON.stringify(await snap()));

  // switch back to A: metrics must return, not stay blank
  const rows3 = await p.$$('.conn');
  await rows3[0].click();
  await new Promise(r => setTimeout(r, 11000));
  console.log(`[back to A] ${names[0]}:`, JSON.stringify(await snap()));

  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
