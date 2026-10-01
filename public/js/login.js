/* Login page logic.
 *
 * ⚠️  This lives in an external file on purpose. The server sends
 *     Content-Security-Policy: script-src 'self', which blocks inline
 *     <script> blocks. An inline handler here would be silently ignored and
 *     the form would appear to do nothing.
 */
(function () {
  'use strict';

  const form = document.getElementById('loginForm');
  const err = document.getElementById('err');
  const btn = document.getElementById('submit');
  const u = document.getElementById('u');
  const p = document.getElementById('p');

  function fail(msg) {
    err.textContent = msg;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Sign in';
    p.value = '';
    p.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u.value, password: p.value })
      });

      let data = {};
      try { data = await res.json(); } catch (e) { /* non-JSON error page */ }

      if (res.ok && data.success) {
        btn.textContent = '✓';
        // Full navigation so the browser picks up the new session cookie.
        location.replace('/');
      } else if (res.status === 429) {
        fail('⏳ Too many attempts. Wait ~15 minutes, then try again.');
      } else {
        fail('❌ ' + (data.error || 'Sign in failed'));
      }
    } catch (e) {
      fail('⚠️ Network error — please try again');
    }
  });

  u.focus();
})();