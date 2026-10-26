// A single shared progress record, intentionally shared by every visitor.
const COUNTS = {charter: [182, 67, 60, 65, 3, 2], history: [234, 156, 231, 90, 27, 4]};
const MODES = ['learn', 'practice', 'random', 'wrong', 'star', 'bank'];
const TYPES = ['all', '单选题', '多选题', '判断题', '填空题', '简答题', '论述题'];
const MAX_BYTES = 512 * 1024;
const HEADERS = {'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff'};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: HEADERS});
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function validId(id) {
    const match = typeof id === 'string' && id.match(/^(charter|history)-([0-5])-([1-9]\d{0,2})$/);
    return !!match && Number(match[3]) <= COUNTS[match[1]][Number(match[2])];
}

function validStamp(stamp) {
    return typeof stamp === 'string' && /^\d{13}-[a-f0-9]{16}$/.test(stamp)
        && Number(stamp.slice(0, 13)) <= Date.now() + 5 * 60 * 1000;
}

function validField(key, value) {
    if (key === '@position') {
        return plain(value) && MODES.includes(value.mode) && ['all', 'charter', 'history'].includes(value.subject)
            && TYPES.includes(value.type) && ['all', 'unseen', 'unmastered'].includes(value.scope)
            && (value.id === null || validId(value.id));
    }
    if (key === '@order') {
        return Array.isArray(value) && value.length <= 1121 && new Set(value).size === value.length && value.every(validId);
    }
    const parts = key.split('|');
    if (parts.length !== 2 || !validId(parts[0])) return false;
    if (parts[1] === 'star' || parts[1] === 'seen') return typeof value === 'boolean';
    if (parts[1] === 'draft') return typeof value === 'string' && value.length <= 30000;
    if (parts[1] === 'answer') {
        return plain(value) && [null, 'mastered', 'wrong'].includes(value.status)
            && Number.isSafeInteger(value.attempts) && value.attempts >= 0 && value.attempts <= 1000000
            && typeof value.last === 'string' && value.last.length <= 40;
    }
    return false;
}

async function snapshot(db, after = 0, requestedKeys = []) {
    // D1 batch runs in one transaction, keeping the revision and changed fields consistent.
    const result = await db.batch([
        db.prepare('SELECT revision, reset_stamp FROM study_meta WHERE id = 1'),
        db.prepare(`SELECT field_key, value_json, stamp FROM study_progress
            WHERE stamp > (SELECT reset_stamp FROM study_meta WHERE id = 1)
            AND (revision > ? OR field_key IN (SELECT value FROM json_each(?)))`)
            .bind(after, JSON.stringify(requestedKeys))
    ]);
    const meta = result[0].results[0];
    const fields = Object.create(null);
    for (const row of result[1].results) fields[row.field_key] = {value: JSON.parse(row.value_json), stamp: row.stamp};
    return {version: 1, revision: meta.revision, resetAt: meta.reset_stamp, fields, serverTime: Date.now()};
}

export async function onRequest({request, env}) {
    if (!env.STUDY_DB) return json({error: '共享进度数据库尚未连接。'}, 503);
    if (!['GET', 'POST'].includes(request.method)) return json({error: '不支持此请求方式。'}, 405);
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return json({error: '仅接受来自本站的请求。'}, 403);
    try {
        if (request.method === 'GET') {
            const after = Number(new URL(request.url).searchParams.get('after') || 0);
            if (!Number.isSafeInteger(after) || after < 0) return json({error: '无效的进度版本。'}, 400);
            return json(await snapshot(env.STUDY_DB, after));
        }
        if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({error: '需要 JSON 数据。'}, 415);
        if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return json({error: '本次同步数据过大。'}, 413);
        // Limit the streamed body too; Content-Length is not guaranteed to be present.
        const reader = request.body?.getReader();
        const chunks = []; let size = 0;
        if (!reader) return json({error: '请求内容为空。'}, 400);
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) {await reader.cancel(); return json({error: '本次同步数据过大。'}, 413);}
            chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
        let body;
        try {body = JSON.parse(new TextDecoder().decode(bytes));} catch {return json({error: '无效的 JSON 数据。'}, 400);}
        if (!plain(body) || !plain(body.changes) || !Number.isSafeInteger(body.after) || body.after < 0) return json({error: '同步数据格式不正确。'}, 400);
        const entries = Object.entries(body.changes);
        if (entries.length > 400) return json({error: '每次最多同步 400 个进度字段。'}, 413);
        if (body.resetAt !== undefined && !validStamp(body.resetAt)) return json({error: '无效的清空标记。'}, 400);
        for (const [key, field] of entries) {
            if (!plain(field) || !validStamp(field.stamp) || !validField(key, field.value)) return json({error: '包含无效的进度字段。'}, 400);
        }
        const operations = [env.STUDY_DB.prepare('UPDATE study_meta SET revision = revision + 1, reset_stamp = MAX(reset_stamp, ?) WHERE id = 1').bind(body.resetAt || '')];
        for (const [key, field] of entries) {
            operations.push(env.STUDY_DB.prepare(`INSERT INTO study_progress (field_key, value_json, stamp, revision)
                VALUES (?, ?, ?, (SELECT revision FROM study_meta WHERE id = 1))
                ON CONFLICT(field_key) DO UPDATE SET value_json = excluded.value_json, stamp = excluded.stamp, revision = excluded.revision
                WHERE excluded.stamp > study_progress.stamp`).bind(key, JSON.stringify(field.value), field.stamp));
        }
        await env.STUDY_DB.batch(operations);
        return json(await snapshot(env.STUDY_DB, body.after, entries.map(([key]) => key)));
    } catch {
        return json({error: '共享进度暂时无法读取，请稍后重试。'}, 503);
    }
}
