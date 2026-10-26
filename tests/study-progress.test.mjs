import test from 'node:test';
import assert from 'node:assert/strict';

// This test intentionally modifies the local development database, never production.
const base = process.env.STUDY_TEST_URL || 'http://127.0.0.1:8788';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Only a local development server may be tested');
const endpoint = base + '/api/study-progress';
let tick = Date.now();
const stamp = () => String(++tick).padStart(13, '0') + '-0123456789abcdef';
const get = async after => {
    const response = await fetch(endpoint + '?after=' + (after || 0));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
};
const post = async (changes, after = 0, resetAt) => {
    const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({changes, after, ...(resetAt ? {resetAt} : {})})});
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
};

test('shared progress merges, protects newer fields, returns deltas, and validates requests', async () => {
    const start = await get();
    const old = stamp(), newer = stamp();
    const answer = {value: {status: 'mastered', attempts: 1, last: new Date().toISOString()}, stamp: newer};
    const first = await post({'charter-0-1|answer': answer});
    assert.equal(first.fields['charter-0-1|answer'].value.status, 'mastered');

    const stale = await post({'charter-0-1|answer': {value: {status: 'wrong', attempts: 1, last: ''}, stamp: old}}, first.revision);
    assert.equal(stale.fields['charter-0-1|answer'].stamp, newer, 'Stale retry must return the actual winner');
    assert.equal(stale.fields['charter-0-1|answer'].value.status, 'mastered');

    await Promise.all([
        post({'charter-0-1|star': {value: true, stamp: stamp()}}),
        post({'history-0-2|answer': {value: {status: 'wrong', attempts: 2, last: ''}, stamp: stamp()}})
    ]);
    const merged = await get();
    assert.equal(merged.fields['charter-0-1|star'].value, true);
    assert.equal(merged.fields['charter-0-1|answer'].value.status, 'mastered');
    assert.equal(merged.fields['history-0-2|answer'].value.status, 'wrong');
    assert.deepEqual((await get(merged.revision)).fields, {}, 'Unchanged polling returns no full snapshot');

    const cleared = await post({'charter-0-1|star': {value: false, stamp: stamp()}}, merged.revision);
    assert.equal(cleared.fields['charter-0-1|star'].value, false, 'Uncollecting is synced as a real value');

    const revision = (await get()).revision;
    const invalid = [
        {'not-a-question|star': {value: true, stamp: stamp()}},
        {'charter-0-999|star': {value: true, stamp: stamp()}},
        {'charter-0-1|star': {value: 'true', stamp: stamp()}},
        {'charter-0-1|draft': {value: 'a'.repeat(30001), stamp: stamp()}},
        {'charter-0-1|seen': {value: true, stamp: '9999999999999-0123456789abcdef'}}
    ];
    for (const changes of invalid) {
        const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({after: revision, changes})});
        assert.equal(response.status, 400);
    }
    assert.equal((await get()).revision, revision, 'Invalid requests must not mutate stored progress');
    assert.equal((await fetch(endpoint, {method: 'DELETE'})).status, 405);
    assert.equal((await fetch(endpoint, {headers: {Origin: 'https://unrelated.example'}})).status, 403);
    assert.equal((await fetch(endpoint + '?after=-1')).status, 400);
    assert.equal((await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: '{}'})).status, 415);

    const resetAt = stamp();
    const reset = await post({}, revision, resetAt);
    assert.equal(reset.resetAt, resetAt);
    assert.deepEqual(reset.fields, {});
    await post({'charter-0-1|answer': answer}, reset.revision);
    assert.deepEqual((await get()).fields, {}, 'A pre-reset device must not resurrect cleared progress');
    await post({'charter-0-2|seen': {value: true, stamp: stamp()}}, reset.revision);
    assert.equal((await get()).fields['charter-0-2|seen'].value, true, 'Practice after reset still saves');
    assert.ok((await get()).revision > start.revision);
});
