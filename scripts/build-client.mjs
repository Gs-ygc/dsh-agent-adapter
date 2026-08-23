/**
 * Bundle the client half into the ModuleLoader factory format the DSH web
 * shell serves at `/plugins/<id>/client.js`: esbuild CJS output wrapped in
 * `window.__ModuleLoader__.load({id, factory})`. React stays external — the
 * shell seeds it.
 */
import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const outfile = 'lib/client-ui.js'
await mkdir('lib', { recursive: true })
await build({
  entryPoints: ['src/client-ui.tsx'],
  bundle: true,
  format: 'cjs',
  jsx: 'automatic',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  external: ['react', 'react/jsx-runtime'],
  outfile: '.client-bundle.tmp.cjs',
  logLevel: 'warning',
})
const body = await readFile('.client-bundle.tmp.cjs', 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-agent-adapter",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body.split('\n').map((line) => (line ? `\t\t${line}` : '')).join('\n')}
\t\treturn module.exports;
\t}
});
`
await writeFile(outfile, wrapped)
const { rm } = await import('node:fs/promises')
await rm('.client-bundle.tmp.cjs', { force: true })
console.log(`client bundle -> ${outfile}`)
