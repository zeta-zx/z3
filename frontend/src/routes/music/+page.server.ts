// src/routes/music/+page.server.ts
import { redirect } from '@sveltejs/kit';

export function load() {
    throw redirect(307, '/music/explore');
}