/** AWS Lambda entry point (payload format 2.0). */

import { route } from './router.js';

export const handler = async (event) => route(event);
