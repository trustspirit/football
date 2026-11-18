// User options, kept on this device. Read anywhere with Options.get('sound').
(function () {
  const KEY = 'mdc-options-v1';
  const DEFAULTS = {
    stamina: false, // stamina + substitutions from a 5-player bench
    sound: true,    // whistle, ball and crowd sounds
  };
  let opts = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    Object.keys(DEFAULTS).forEach((k) => { if (typeof saved[k] === typeof DEFAULTS[k]) opts[k] = saved[k]; });
  } catch (_) { /* private mode etc. */ }

  const listeners = [];
  window.Options = {
    get: (k) => opts[k],
    set(k, v) {
      opts[k] = v;
      try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch (_) { /* ignore */ }
      listeners.forEach((fn) => fn(k, v));
    },
    onChange: (fn) => listeners.push(fn),
  };
})();
