// Lets `tsx --test` import UI modules that import static assets the way Vite does
// (a stylesheet for its side effect, an image for its URL). Node cannot load
// .css or .webp, so each one becomes a module whose default export is its file
// name. Test-only: passed with `--import` in package.json `test:unit`.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
const ASSET = /\\.(css|webp|png|jpe?g|svg|gif|woff2?)(\\?.*)?$/i;
export async function load(url, context, next) {
  if (ASSET.test(url)) {
    const name = url.split('/').pop().split('?')[0];
    return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(name) + ';' };
  }
  return next(url, context);
}
`));
