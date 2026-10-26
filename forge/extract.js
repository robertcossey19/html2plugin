/* Static fallback extraction of AudioWorklet module source from page HTML (used when the headless boot could not reach addModule). */
const acorn = require('acorn'); const walk = require('acorn-walk');
function extractWorkletModulesStatic(html) {
  const modules = [], log = [];
  // <script type="worklet"|"text/worklet"|"audioworklet"|id~=worklet> ... </script>
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] || '', body = m[2] || '';
    const type = (attrs.match(/type=["']([^"']+)["']/i) || [])[1] || '';
    if ((/worklet/i.test(type) || /worklet/i.test(attrs)) && /registerProcessor\s*\(/.test(body)) { modules.push(body); log.push('worklet module from <script type="' + type + '">'); }
  }
  if (modules.length) return { modules, log };
  // template literals / string literals containing registerProcessor( inside normal scripts
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] || '', body = m[2] || ''; if (/\bsrc=/.test(attrs) || !/registerProcessor\s*\(/.test(body)) continue;
    let ast; try { ast = acorn.parse(body, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }); } catch (e) { try { ast = acorn.parse(body, { ecmaVersion: 'latest', sourceType: 'module' }); } catch (e2) { log.push('parse failed: ' + e2.message); continue; } }
    walk.simple(ast, {
      TemplateLiteral(node) {
        const raw = node.quasis.map(q => q.value.cooked == null ? q.value.raw : q.value.cooked).join('');
        if (!/registerProcessor\s*\(/.test(raw)) return;
        if (node.expressions.length === 0) { modules.push(raw); log.push('worklet module from template literal (static)'); return; }
        // has ${...}: try evaluating the literal with the script's top-level const/let/var declarations in scope
        const decls = []; for (const st of ast.body) if (st.type === 'VariableDeclaration') decls.push(body.slice(st.start, st.end)); else if (st.type === 'FunctionDeclaration') decls.push(body.slice(st.start, st.end));
        try { const vm = require('vm'); const code = decls.join('\n') + '\n;(' + body.slice(node.start, node.end) + ')'; const out = vm.runInNewContext(code, { Math, JSON, Number, String, Array, Object, console: { log() { } } }, { timeout: 2000 }); if (typeof out === 'string' && /registerProcessor/.test(out)) { modules.push(out); log.push('worklet module from template literal (evaluated with top-level declarations)'); } }
        catch (e) { log.push('template literal with expressions could not be evaluated statically: ' + e.message); }
      },
      Literal(node) { if (typeof node.value === 'string' && /registerProcessor\s*\(/.test(node.value) && node.value.length > 200) { modules.push(node.value); log.push('worklet module from string literal'); } },
    });
  }
  return { modules, log };
}
module.exports = { extractWorkletModulesStatic };
