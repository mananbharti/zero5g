// Local-only result history. Storage can be unavailable (private mode), so every call is guarded.
const KEY = 'zero5g.history.v1';
const MAX = 20;

const store = () => { try { return window.localStorage; } catch { return null; } };

export function loadHistory() {
  const s = store();
  if (!s) return [];
  try {
    const v = JSON.parse(s.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((r) => r && Number.isFinite(r.down)) : [];
  } catch { return []; }
}

export function saveRun(run) {
  const list = [run, ...loadHistory()].slice(0, MAX);
  const s = store();
  if (s) { try { s.setItem(KEY, JSON.stringify(list)); } catch { /* quota */ } }
  return list;
}

export function clearHistory() {
  const s = store();
  if (s) { try { s.removeItem(KEY); } catch { /* ignore */ } }
}

export function getPref(k, fallback) {
  const s = store();
  try { return (s && s.getItem('zero5g.' + k)) || fallback; } catch { return fallback; }
}
export function setPref(k, v) {
  const s = store();
  try { s && s.setItem('zero5g.' + k, v); } catch { /* ignore */ }
}
