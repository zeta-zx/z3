import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeLyricIndex, playbackPosition } from './activity/timing.mjs';

test('the Activity clock accounts for sample age while playing and stops while paused', () => {
    const state = { position: 3.2, ageMs: 500, duration: 7, phase: 'playing' };
    assert.equal(playbackPosition(state, 800), 4.5);
    assert.equal(playbackPosition(state, 8000), 7);
    assert.equal(playbackPosition({ ...state, phase: 'paused' }, 800), 3.2);
    assert.equal(playbackPosition({ ...state, phase: 'loading' }, 800), 3.2);
});

test('lyric timing follows both forward and backward seeks and skips empty gaps before the first line', () => {
    const lines = [{ time: 1 }, { time: 3 }, { time: 6.25 }];
    assert.equal(activeLyricIndex(lines, 0.9), -1);
    assert.equal(activeLyricIndex(lines, 3), 1);
    assert.equal(activeLyricIndex(lines, 10), 2);
    assert.equal(activeLyricIndex(lines, 1.2), 0);
});
