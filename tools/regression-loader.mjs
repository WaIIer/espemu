// Lets project tests outside the framework import the public regression client as 'espemu/regression'; register after tsx so tsx still compiles the target.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
const target = ${JSON.stringify(new URL('./project-regression.ts', import.meta.url).href)};
export async function resolve(specifier, context, next) {
  if (specifier === 'espemu/regression') return next(target, context);
  return next(specifier, context);
}
`));
