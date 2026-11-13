import { createApp } from './app.mjs';
const port = Number(process.env.PORT || 4030);
const app = await createApp();
const server = app.listen(port, '127.0.0.1', () => console.log(`\n  mini_LaTeX_Editor is ready\n  Local: http://127.0.0.1:${port}\n  Press Ctrl+C to stop.\n`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another number.` : error); process.exitCode = 1; });
