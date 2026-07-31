/**
 * CapSolver-compatible captcha token client.
 * When API key is missing, the solver is disabled and the runner falls back to human intervention.
 */

function normalizeCaptchaConfig(raw = {}, env = process.env) {
  const apiKey = String(raw.apiKey || env.CAPSOLVER_API_KEY || '').trim();
  const provider = String(raw.provider || 'capsolver').trim().toLowerCase();
  const fallbackToHuman = raw.fallbackToHuman !== false;
  return {
    provider,
    apiKey,
    enabled: Boolean(apiKey) && provider !== 'manual' && provider !== 'none',
    fallbackToHuman,
    apiBase: String(raw.apiBase || 'https://api.capsolver.com').replace(/\/$/, ''),
    pollIntervalMs: Number(raw.pollIntervalMs) > 0 ? Number(raw.pollIntervalMs) : 2000,
    timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 120000
  };
}

function mapCaptchaTypeToTask(type, useProxy) {
  const key = String(type || '').toLowerCase();
  if (key.includes('hcaptcha') || key === 'hcaptcha') {
    return useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess';
  }
  if (key.includes('turnstile')) {
    return useProxy ? 'AntiTurnstileTaskProxyLess' : 'AntiTurnstileTaskProxyLess';
  }
  if (key.includes('recaptcha') || key.includes('g-recaptcha')) {
    return useProxy ? 'ReCaptchaV2Task' : 'ReCaptchaV2TaskProxyLess';
  }
  return useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess';
}

function buildInjectTokenScriptArgs(token) {
  return { token: String(token || '') };
}

function createCaptchaSolver(rawConfig = {}, env = process.env) {
  const config = normalizeCaptchaConfig(rawConfig, env);
  const fetchImpl = rawConfig.fetchImpl || fetch;

  function isEnabled() {
    return config.enabled;
  }

  async function solve(task = {}) {
    if (!isEnabled()) return null;
    const websiteURL = String(task.websiteURL || '').trim();
    const websiteKey = String(task.websiteKey || '').trim();
    if (!websiteURL || !websiteKey) {
      throw new Error('Captcha solve requires websiteURL and websiteKey');
    }

    const useProxy = Boolean(task.proxy);
    const taskBody = {
      type: mapCaptchaTypeToTask(task.type || 'hcaptcha', useProxy),
      websiteURL,
      websiteKey
    };
    if (useProxy) {
      // CapSolver proxy string: ip:port:user:pass or protocol://user:pass@ip:port
      taskBody.proxy = task.proxy;
    }
    if (task.userAgent) taskBody.userAgent = task.userAgent;

    const createRes = await fetchImpl(`${config.apiBase}/createTask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientKey: config.apiKey,
        task: taskBody
      })
    });
    const createJson = await createRes.json();
    if (createJson.errorId) {
      throw new Error(createJson.errorDescription || `CapSolver createTask error ${createJson.errorId}`);
    }
    const taskId = createJson.taskId;
    if (!taskId) throw new Error('CapSolver createTask returned no taskId');

    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
      const resultRes = await fetchImpl(`${config.apiBase}/getTaskResult`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientKey: config.apiKey,
          taskId
        })
      });
      const resultJson = await resultRes.json();
      if (resultJson.errorId) {
        throw new Error(resultJson.errorDescription || `CapSolver getTaskResult error ${resultJson.errorId}`);
      }
      if (resultJson.status === 'ready') {
        const solution = resultJson.solution || {};
        return solution.gRecaptchaResponse
          || solution.token
          || solution.respKey
          || null;
      }
    }
    throw new Error('CapSolver timed out waiting for captcha solution');
  }

  return {
    isEnabled,
    solve,
    config
  };
}

/**
 * Best-effort extract of captcha type + sitekey from the current page (main + frames).
 */
async function extractCaptchaTaskFromPage(page) {
  if (!page) return null;
  const frames = typeof page.frames === 'function' ? page.frames() : [page];
  for (const frame of frames) {
    try {
      const found = await frame.evaluate(() => {
        const pickSitekey = root => {
          const el = root.querySelector('[data-sitekey], .h-captcha[data-sitekey], .g-recaptcha[data-sitekey]');
          return el?.getAttribute?.('data-sitekey') || '';
        };
        let sitekey = pickSitekey(document);
        let type = '';
        const iframes = Array.from(document.querySelectorAll('iframe[src]'));
        for (const iframe of iframes) {
          const src = iframe.getAttribute('src') || '';
          if (/hcaptcha/i.test(src)) {
            type = 'hcaptcha';
            const match = src.match(/[?&]sitekey=([^&]+)/i);
            if (match) sitekey = decodeURIComponent(match[1]);
          } else if (/recaptcha/i.test(src)) {
            type = 'recaptcha';
            const match = src.match(/[?&]k=([^&]+)/i);
            if (match) sitekey = decodeURIComponent(match[1]);
          } else if (/turnstile|challenges\.cloudflare/i.test(src)) {
            type = 'turnstile';
          }
        }
        if (!type) {
          if (document.querySelector('.h-captcha, iframe[src*="hcaptcha"]')) type = 'hcaptcha';
          else if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]')) type = 'recaptcha';
          else if (document.querySelector('iframe[src*="turnstile"]')) type = 'turnstile';
        }
        if (!sitekey) sitekey = pickSitekey(document);
        if (!type && !sitekey) return null;
        return { type: type || 'hcaptcha', websiteKey: sitekey };
      });
      if (found && found.websiteKey) {
        return {
          type: found.type,
          websiteKey: found.websiteKey,
          websiteURL: typeof page.url === 'function' ? page.url() : ''
        };
      }
    } catch (error) {
      // frame may detach mid-scan
    }
  }
  return null;
}

/**
 * Inject captcha token into response fields and invoke common callbacks.
 */
async function injectCaptchaToken(page, token) {
  if (!page || !token) return false;
  const frames = typeof page.frames === 'function' ? page.frames() : [page];
  let injected = false;
  for (const frame of frames) {
    try {
      const ok = await frame.evaluate(({ token: value }) => {
        const names = ['h-captcha-response', 'g-recaptcha-response', 'cf-turnstile-response'];
        let wrote = false;
        for (const name of names) {
          const nodes = document.querySelectorAll(
            `textarea[name="${name}"], input[name="${name}"], textarea#${name}, #${name}`
          );
          nodes.forEach(node => {
            node.value = value;
            node.innerHTML = value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            wrote = true;
          });
        }
        // hCaptcha / reCAPTCHA client callbacks when exposed
        try {
          if (typeof window.hcaptcha?.setResponse === 'function') {
            window.hcaptcha.setResponse(value);
            wrote = true;
          }
        } catch (_) {}
        try {
          if (typeof window.grecaptcha?.getResponse === 'function') {
            // cannot set grecaptcha response directly; rely on textarea
          }
        } catch (_) {}
        const widgets = document.querySelectorAll('[data-callback]');
        widgets.forEach(widget => {
          const cbName = widget.getAttribute('data-callback');
          if (cbName && typeof window[cbName] === 'function') {
            try { window[cbName](value); wrote = true; } catch (_) {}
          }
        });
        return wrote;
      }, buildInjectTokenScriptArgs(token));
      if (ok) injected = true;
    } catch (error) {
      // ignore detached frames
    }
  }
  return injected;
}

module.exports = {
  normalizeCaptchaConfig,
  createCaptchaSolver,
  mapCaptchaTypeToTask,
  buildInjectTokenScriptArgs,
  extractCaptchaTaskFromPage,
  injectCaptchaToken
};
