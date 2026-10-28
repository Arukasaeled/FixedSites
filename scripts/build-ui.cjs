const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const native = path.join(root, 'src', 'native');
const bridge = path.join(native, 'bin', 'AgentBridge-1.0.0.exe');
const sources = ['NativeWindows.cs', 'AgentBridge.cs', 'app.manifest'].map((file) => path.join(native, file));
// Compile the small Windows helper only when its sources changed. No download,
// extra runtime installation or native Node module is required.
if (process.platform === 'win32' && (!fs.existsSync(bridge) || sources.some((file) => fs.statSync(file).mtimeMs > fs.statSync(bridge).mtimeMs))) {
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${bridge}`,
    `/win32manifest:${sources[2]}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    `/reference:${path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF', 'UIAutomationClient.dll')}`,
    `/reference:${path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF', 'UIAutomationTypes.dll')}`,
    `/reference:${path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'WPF', 'WindowsBase.dll')}`,
    sources[0], sources[1]], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  process.stdout.write('Native Agents helper compiled.\n');
}
const output = path.join(root, 'src', 'ui-dist');
fs.mkdirSync(output, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'ui', 'App.jsx')],
  outfile: path.join(output, 'app.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome134',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const css = spawnSync(process.execPath, [
  path.join(root, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs'),
  '-i', path.join(root, 'src', 'ui', 'styles.css'),
  '-o', path.join(output, 'styles.css'), '--minify',
], { cwd: root, stdio: 'inherit' });
if (css.status !== 0) process.exit(css.status || 1);
fs.copyFileSync(path.join(root, 'src', 'ui', 'index.html'), path.join(output, 'index.html'));
fs.cpSync(path.join(root, 'src', 'ui', 'brand'), path.join(output, 'brand'), { recursive: true });
process.stdout.write('Static renderer built: src/ui-dist\n');
