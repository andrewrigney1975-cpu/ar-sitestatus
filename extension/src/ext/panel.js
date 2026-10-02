// Sidebar entry point: connect the extension host first, then start the shared web app.
import { installHost } from './host.js';

await installHost();
await import('../js/app.js');
