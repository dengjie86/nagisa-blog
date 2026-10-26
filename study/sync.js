/* Shared, local-first progress for every visitor to this page. */
(() => {
    'use strict';
    const META_KEY = 'wengu-shared-progress-v1';
    const ENDPOINT = '/api/study-progress';
    const actor = Array.from(crypto.getRandomValues(new Uint8Array(8)), n => n.toString(16).padStart(2, '0')).join('');
    let meta = {version: 1, revision: 0, resetAt: '', fields: {}, pending: {}, pendingReset: false, acks: {}, resetAck: ''};
    let suppressed = false, busy = null, timer, needsApply = false, clock = 0, clockOffset = 0;
    const deepCopy = value => JSON.parse(JSON.stringify(value));
    try {
        const saved = JSON.parse(localStorage.getItem(META_KEY) || 'null');
        if (saved?.version === 1 && saved.fields && saved.pending && Number.isSafeInteger(saved.revision)) meta = saved;
    } catch { /* The page can still sync without persistent browser storage. */ }
    meta.acks ||= {};
    meta.resetAck ??= meta.pendingReset ? '' : meta.resetAt;
    for (const [key, field] of Object.entries(meta.fields)) {
        clock = Math.max(clock, Number(field.stamp?.slice(0, 13)) || 0);
        if (!meta.pending[key] && !meta.acks[key]) meta.acks[key] = field.stamp;
    }

    function stamp() {
        clock = Math.max(Math.round(Date.now() + clockOffset), clock + 1);
        return String(clock).padStart(13, '0') + '-' + actor;
    }

    function flatten() {
        const fields = {};
        for (const [id, r] of Object.entries(state.records)) {
            if (!BY_ID.has(id)) continue;
            fields[id + '|seen'] = !!r.seen;
            fields[id + '|star'] = !!r.star;
            fields[id + '|draft'] = String(r.draft || '').slice(0, 30000);
            fields[id + '|answer'] = {status: r.status || null, attempts: Math.min(1000000, Math.max(0, Math.floor(r.attempts || 0))), last: String(r.last || '').slice(0, 40)};
        }
        fields['@position'] = {...state.settings, id: state.cursor[cursorKey()] || queue[index]?.id || null};
        fields['@order'] = [...state.order];
        return fields;
    }

    let baseline = flatten();
    // Migrate old browser-only progress using its original answer time. Empty defaults
    // use the oldest stamp, so opening a fresh device cannot overwrite cloud progress.
    for (const [key, value] of Object.entries(baseline)) {
        if (meta.fields[key]) continue;
        if (key.startsWith('@') && !Object.values(state.records).some(r => r.status || r.star || r.draft)) continue;
        const r = state.records[key.split('|')[0]];
        const originalTime = Math.min(Date.now(), Math.max(1, Date.parse(r?.last || '') || 1));
        const oldStamp = String(originalTime).padStart(13, '0') + '-' + actor;
        if (oldStamp <= meta.resetAt) continue;
        meta.fields[key] = {value: deepCopy(value), stamp: oldStamp};
        meta.pending[key] = oldStamp;
    }

    function persist() {
        try {localStorage.setItem(META_KEY, JSON.stringify(meta));} catch { /* Keep pending changes in memory. */ }
    }

    function showStatus(next, message) {
        $('sync-bar').dataset.state = next;
        $('sync-status').textContent = message;
        $('sync-detail').textContent = next === 'offline' ? '本机修改已保留，恢复网络后会自动补传。'
            : next === 'error' ? '本机修改已保留，可点击重试；不会显示为已同步。'
            : '所有访问者共用一份进度 · 不需要登录';
        $('sync-now').disabled = next === 'syncing';
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(() => flush(), 700);
    }

    function capture() {
        if (suppressed) return;
        const current = flatten(); let changed = false;
        for (const [key, value] of Object.entries(current)) {
            if (JSON.stringify(value) === JSON.stringify(baseline[key])) continue;
            const time = stamp();
            meta.fields[key] = {value: deepCopy(value), stamp: time};
            meta.pending[key] = time;
            changed = true;
        }
        baseline = current;
        if (changed) {
            persist();
            showStatus(navigator.onLine ? 'pending' : 'offline', navigator.onLine ? '有新进度，等待同步…' : '当前离线');
            schedule();
        }
    }

    function reset() {
        meta.resetAt = stamp(); meta.pendingReset = true;
        meta.fields = {}; meta.pending = {}; meta.acks = {}; baseline = flatten();
        persist(); schedule();
    }

    function merge(data, fromCache = false) {
        if (data.version !== 1 || !Number.isSafeInteger(data.revision) || !data.fields) throw new Error('服务器返回了无效的进度。');
        clockOffset = data.serverTime - Date.now();
        let changed = false, metadataChanged = false;
        if (data.resetAt > meta.resetAt) {
            meta.resetAt = data.resetAt; changed = true;
        }
        const resetAck = fromCache ? data.resetAck || '' : data.resetAt;
        if (resetAck > meta.resetAck) {meta.resetAck = resetAck; metadataChanged = true;}
        meta.pendingReset = meta.resetAt > meta.resetAck;
        const acknowledgements = fromCache ? data.acks || {} : Object.fromEntries(Object.entries(data.fields).map(([key, field]) => [key, field.stamp]));
        for (const [key, time] of Object.entries(acknowledgements)) {
            if (time > (meta.acks[key] || '')) {meta.acks[key] = time; metadataChanged = true;}
        }
        for (const [key, field] of Object.entries(meta.fields)) {
            if (field.stamp <= meta.resetAt) {delete meta.fields[key]; delete meta.pending[key]; delete meta.acks[key]; changed = true;}
        }
        for (const [key, field] of Object.entries(data.fields)) {
            if (field.stamp <= meta.resetAt) continue;
            clock = Math.max(clock, Number(field.stamp.slice(0, 13)));
            if (!meta.fields[key] || field.stamp > meta.fields[key].stamp) {meta.fields[key] = field; changed = true;}
        }
        for (const [key, field] of Object.entries(meta.fields)) {
            if (field.stamp > (meta.acks[key] || '')) meta.pending[key] = field.stamp;
            else delete meta.pending[key];
        }
        if (data.revision > meta.revision) {meta.revision = data.revision; metadataChanged = true;}
        if (!fromCache || changed || metadataChanged) persist();
        if (changed || needsApply) applyShared();
    }

    function applyShared() {
        // Do not replace the textarea, its selection, or its draft while typing.
        if (document.activeElement?.id === 'response') {needsApply = true; return;}
        needsApply = false;
        const records = {};
        for (const [key, field] of Object.entries(meta.fields)) {
            if (key.startsWith('@') || field.stamp <= meta.resetAt) continue;
            const [id, part] = key.split('|');
            if (!BY_ID.has(id)) continue;
            records[id] ||= {};
            if (part === 'answer') Object.assign(records[id], field.value);
            else records[id][part] = field.value;
        }
        suppressed = true;
        try {
            state.records = cleanRecords(records);
            const order = meta.fields['@order']?.value;
            if (Array.isArray(order)) state.order = order.filter(id => BY_ID.has(id));
            const position = meta.fields['@position']?.value;
            if (position && !selected.length && !submitted) {
                state.settings = {mode: position.mode, subject: position.subject, type: position.type, scope: position.scope};
                mode = state.settings.mode;
                if (position.id) state.cursor[cursorKey()] = position.id;
                buildQueue(false, position.id);
            } else render();
            baseline = flatten();
        } finally {suppressed = false;}
    }

    function nextChanges() {
        const changes = {}; let bytes = 0;
        for (const key of Object.keys(meta.pending)) {
            const field = meta.fields[key];
            if (!field || field.stamp <= meta.resetAt) {delete meta.pending[key]; continue;}
            const estimate = JSON.stringify(field).length * 3;
            if (Object.keys(changes).length >= 400 || bytes + estimate > 450000) break;
            changes[key] = field; bytes += estimate;
        }
        return deepCopy(changes);
    }

    async function request(changes) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(changes ? ENDPOINT : ENDPOINT + '?after=' + meta.revision, {
                method: changes ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal,
                headers: changes ? {'Content-Type': 'application/json'} : {},
                body: changes ? JSON.stringify({after: meta.revision, changes, ...(meta.pendingReset ? {resetAt: meta.resetAt} : {})}) : undefined
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '同步暂时不可用。');
            return data;
        } finally {clearTimeout(timeout);}
    }

    async function runSync() {
        if (!navigator.onLine) {showStatus('offline', '当前离线'); return false;}
        showStatus('syncing', '正在同步共享进度…');
        try {
            // Fetch first, so a stale device and its old local defaults do not win.
            merge(await request());
            for (let batch = 0; batch < 20; batch++) {
                const changes = nextChanges();
                if (!Object.keys(changes).length && !meta.pendingReset) break;
                merge(await request(changes));
            }
            if (Object.keys(meta.pending).length || meta.pendingReset) {
                showStatus('pending', '仍有进度等待同步…'); schedule(); return false;
            }
            showStatus('synced', '共享进度已同步 · ' + new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}));
            return true;
        } catch (error) {
            showStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? '同步未完成，请重试' : '当前离线');
            return false;
        }
    }

    function flush() {
        clearTimeout(timer);
        if (busy) return busy;
        capture();
        busy = runSync().finally(() => {busy = null;});
        return busy;
    }

    window.studySync = {capture, reset, flush};
    $('sync-now').onclick = () => flush();
    window.addEventListener('online', () => flush());
    window.addEventListener('offline', () => showStatus('offline', '当前离线'));
    window.addEventListener('focus', () => flush());
    document.addEventListener('visibilitychange', () => {if (!document.hidden) flush();});
    document.addEventListener('focusout', event => {
        if (event.target.id === 'response' && needsApply) setTimeout(() => applyShared(), 0);
    });
    // Tabs in the same browser also share pending offline changes.
    window.addEventListener('storage', event => {
        if (event.key !== META_KEY || !event.newValue) return;
        try {
            const incoming = JSON.parse(event.newValue);
            merge({...incoming, serverTime: Date.now() + clockOffset}, true); schedule();
        } catch { /* A malformed cache must not stop ongoing practice. */ }
    });
    window.addEventListener('pagehide', () => {
        capture();
        if (!navigator.onLine || (!Object.keys(meta.pending).length && !meta.pendingReset)) return;
        const body = JSON.stringify({after: meta.revision, changes: nextChanges(), ...(meta.pendingReset ? {resetAt: meta.resetAt} : {})});
        const blob = new Blob([body], {type: 'application/json'});
        if (blob.size < 60000) navigator.sendBeacon(ENDPOINT, blob);
    });
    setInterval(() => {if (!document.hidden && !busy) flush();}, 8000);
    persist(); flush();
})();
