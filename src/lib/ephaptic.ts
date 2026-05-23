import { connect } from '@ephaptic/client';

import type { Routes } from '../../electron/main';

export const client: Routes = connect(); // *Should* default to Electron as it should detects it. If it does, then clean DX :D