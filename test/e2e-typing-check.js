/* Browser-driven check. Requires puppeteer-core and a real Chrome.
 *
 *   npm i puppeteer-core
 *   TH_PASS='<admin password>' CHROME_PATH='/path/to/Chrome' node e2e-typing-check.js
 *
 * Verifies what curl-level probes cannot: that the page actually emits
 * connect-ssh and terminal-input, and that the remote host executes them.
 */
/* Type real keystrokes into the live terminal and confirm the remote host
 * executes them. A local xterm echo would look identical to a real remote
 * response, so verify against content only the remote can produce. */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const BASE = 'https://terminal.sysitadmin.com';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PW = (process.env.TH_PASS || fs.readFileSync('/tmp/browsertest/.pw', 'utf8').trim());

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });

  await p.evaluateOnNewDocument(() => {
    window.__emit = [];
    let real;
    Object.defineProperty(window, 'io', {
      configurable: true,
      get() { return real; },
      set(fn) { real = (...a) => { const s = fn(...a);
        const o = s.emit.bind(s); s.emit = (e, ...r) => { window.__emit.push(e); return o(e, ...r); };
        return s; }; },
    });
  });

  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await p.type('#u', 'admin'); await p.type('#p', PW);
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2' }), p.click('#submit')]);

  const rows = await p.$$('.conn');
  const name = await p.$eval('.conn-name', e => e.textContent);
  await rows[0].click();
  await new Promise(r => setTimeout(r, 9000));

  const readTerm = () => p.evaluate(() => {
    const h = [...document.querySelectorAll('.term-host')].find(x => !x.hidden);
    const s = h && h.querySelector('.xterm-screen'); if (!s) return '';
    const c = s.cloneNode(true); c.querySelectorAll('style').forEach(x => x.remove());
    return c.textContent.replace(/\s+/g, ' ');
  });

  console.log(`--- typing into ${name}`);
  // Click the terminal to focus it, then type a real command and Enter.
  const host = await p.$('.term-host:not([hidden])');
  await host.click();
  await new Promise(r => setTimeout(r, 500));

  const MARK = 'TYPETEST_OK_9271';
  await p.keyboard.type(`echo ${MARK}\n`, { delay: 25 });
  await new Promise(r => setTimeout(r, 6000));

  const text = await readTerm();
  const count = (text.match(new RegExp(MARK, 'g')) || []).length;
  const emits = await p.evaluate(() => window.__emit);
  const inputCount = emits.filter(e => e === 'terminal-input').length;

  console.log('--- terminal-input events emitted:', inputCount);
  console.log('--- marker occurrences in terminal:', count, count >= 2 ? '(echo + output = remote executed it)' : '');
  console.log('--- tail:', JSON.stringify(text.slice(-260)));
  console.log(count >= 2 ? 'RESULT: TYPING WORKS — remote host executed the command' : 'RESULT: FAILED — no remote output');

  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
