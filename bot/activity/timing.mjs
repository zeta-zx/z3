export function playbackPosition(snapshot, elapsedMs = 0) {
    if (!snapshot) return 0;
    const position = Math.max(0, Number(snapshot.position) || 0);
    const elapsed = snapshot.phase === 'playing'
        ? (Math.max(0, Number(snapshot.ageMs) || 0) + Math.max(0, elapsedMs)) / 1000 : 0;
    const duration = Number(snapshot.duration) || 0;
    return duration > 0 ? Math.min(duration, position + elapsed) : position + elapsed;
}

export function activeLyricIndex(items, position) {
    let low = 0;
    let high = items.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (items[middle].time <= position) low = middle + 1;
        else high = middle - 1;
    }
    return high;
}
