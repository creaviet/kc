/** AWS Lambda entry point (API Gateway HTTP API, payload format 2.0). */
import { route } from './router.js';

export const handler = async (event, context) => route(event, context);
