/* global mermaid, acorn */
(() => {
  'use strict';

  const els = {
    fileInput: document.querySelector('#file-input'),
    dropZone: document.querySelector('#drop-zone'),
    fileName: document.querySelector('#file-name'),
    analyzeBtn: document.querySelector('#analyze-btn'),
    clearBtn: document.querySelector('#clear-btn'),
    loadDemoBtn: document.querySelector('#load-demo-btn'),
    mermaidSource: document.querySelector('#mermaid-source'),
    renderBtn: document.querySelector('#render-btn'),
    copyBtn: document.querySelector('#copy-btn'),
    downloadMmdBtn: document.querySelector('#download-mmd-btn'),
    downloadSvgBtn: document.querySelector('#download-svg-btn'),
    fitBtn: document.querySelector('#fit-btn'),
    diagram: document.querySelector('#diagram'),
    diagramEmpty: document.querySelector('#diagram-empty'),
    diagramWrap: document.querySelector('#diagram-wrap'),
    statusBar: document.querySelector('#status-bar'),
    statusText: document.querySelector('#status-text'),
    functionCount: document.querySelector('#function-count'),
    importCount: document.querySelector('#import-count'),
    callCount: document.querySelector('#call-count'),
    externalCount: document.querySelector('#external-count'),
    showImports: document.querySelector('#show-imports'),
    showExternal: document.querySelector('#show-external'),
    showReturns: document.querySelector('#show-returns'),
    direction: document.querySelector('#direction')
  };

  let sourceText = '';
  let sourceName = '';
  let lastAnalysis = null;
  let lastSvg = '';

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    flowchart: {
      htmlLabels: false,
      curve: 'basis',
      nodeSpacing: 32,
      rankSpacing: 50
    }
  });

  function language() {
    return document.querySelector(
      'input[name="language"]:checked'
    ).value;
  }

  function setStatus(message, level = 'idle') {
    els.statusText.textContent = message;
    els.statusBar.dataset.level = level;
  }

  function resetMetrics() {
    els.functionCount.textContent = '0';
    els.importCount.textContent = '0';
    els.callCount.textContent = '0';
    els.externalCount.textContent = '0';
  }

  function updateMetrics(analysis) {
    els.functionCount.textContent =
      String(analysis.functions.length);

    els.importCount.textContent =
      String(analysis.imports.length);

    els.callCount.textContent =
      String(
        analysis.calls.filter(
          call => !call.external
        ).length
      );

    els.externalCount.textContent =
      String(
        analysis.calls.filter(
          call => call.external
        ).length
      );
  }

  function escapeMermaid(text) {
    return String(text ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('[', '&#91;')
      .replaceAll(']', '&#93;')
      .replaceAll('{', '&#123;')
      .replaceAll('}', '&#125;')
      .replace(/\r?\n/g, ' ');
  }

  function safeId(prefix, value, index) {
    const slug = String(value)
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/^([0-9])/, '_$1');

    return `${prefix}_${slug || 'anonymous'}_${index}`;
  }

  async function readFile(file) {
    sourceText = await file.text();
    sourceName = file.name;

    els.fileName.textContent =
      `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;

    els.analyzeBtn.disabled = !sourceText.trim();

    setStatus(
      `Loaded ${file.name}. Language selection: ${language()}.`,
      'ok'
    );
  }

  /*
   * ==========================================================
   * JavaScript analysis
   * ==========================================================
   */

  function walkJs(
    node,
    visit,
    parent = null,
    ancestors = []
  ) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (typeof node.type === 'string') {
      visit(node, parent, ancestors);
    }

    const nextAncestors =
      typeof node.type === 'string'
        ? [...ancestors, node]
        : ancestors;

    for (const [key, value] of Object.entries(node)) {
      if (
        key === 'start' ||
        key === 'end' ||
        key === 'loc'
      ) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const child of value) {
          walkJs(
            child,
            visit,
            node,
            nextAncestors
          );
        }
      } else if (
        value &&
        typeof value === 'object'
      ) {
        walkJs(
          value,
          visit,
          node,
          nextAncestors
        );
      }
    }
  }

  function jsNodeName(node, parent) {
    if (node.id?.name) {
      return node.id.name;
    }

    if (
      (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression'
      ) &&
      parent?.type === 'VariableDeclarator'
    ) {
      return parent.id?.name || '<anonymous>';
    }

    if (
      (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression'
      ) &&
      parent?.type === 'Property'
    ) {
      return (
        parent.key?.name ||
        parent.key?.value ||
        '<anonymous>'
      );
    }

    return '<anonymous>';
  }

  function jsTypeFromAnnotation(param) {
    return (
      param?.typeAnnotation
        ?.typeAnnotation
        ?.type ||
      'unknown'
    );
  }

  function jsParamLabel(param) {
    if (!param) {
      return '?';
    }

    if (param.type === 'Identifier') {
      return `${param.name}: ${jsTypeFromAnnotation(param)}`;
    }

    if (param.type === 'AssignmentPattern') {
      return `${jsParamLabel(param.left)} = …`;
    }

    if (param.type === 'RestElement') {
      return `...${jsParamLabel(param.argument)}`;
    }

    if (param.type === 'ObjectPattern') {
      return '{…}: object';
    }

    if (param.type === 'ArrayPattern') {
      return '[…]: array';
    }

    return `${param.type}: unknown`;
  }

  function jsCalleeName(callee) {
    if (!callee) {
      return null;
    }

    if (callee.type === 'Identifier') {
      return callee.name;
    }

    if (callee.type === 'MemberExpression') {
      const left =
        jsCalleeName(callee.object);

      const right =
        callee.property?.name ||
        callee.property?.value;

      return (
        left && right
          ? `${left}.${right}`
          : right || left
      );
    }

    if (callee.type === 'Super') {
      return 'super';
    }

    return null;
  }

  function jsReturnSummary(fnNode) {
    const values = new Set();

    walkJs(
      fnNode.body,
      (node, parent, ancestors) => {
        const nestedFn =
          ancestors
            .slice(1)
            .some(
              ancestor =>
                /Function/.test(
                  ancestor.type
                )
            );

        if (nestedFn) {
          return;
        }

        if (node.type !== 'ReturnStatement') {
          return;
        }

        if (!node.argument) {
          values.add('void');
          return;
        }

        if (node.argument.type === 'Literal') {
          values.add(
            typeof node.argument.value
          );
          return;
        }

        if (
          node.argument.type ===
          'ObjectExpression'
        ) {
          values.add('object');
          return;
        }

        if (
          node.argument.type ===
          'ArrayExpression'
        ) {
          values.add('array');
          return;
        }

        if (
          node.argument.type ===
          'AwaitExpression'
        ) {
          values.add(
            'Promise/awaited'
          );
          return;
        }

        values.add('unknown');
      }
    );

    return values.size
      ? [...values].join(' | ')
      : 'void/implicit';
  }

  function analyzeJavaScript(text) {
    if (typeof acorn === 'undefined') {
      throw new Error(
        'Acorn parser was not loaded. Add vendor/acorn.min.js.'
      );
    }

    let ast;

    try {
      ast = acorn.parse(text, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
        allowHashBang: true
      });
    } catch (moduleError) {
      try {
        ast = acorn.parse(text, {
          ecmaVersion: 'latest',
          sourceType: 'script',
          locations: true,
          allowHashBang: true
        });
      } catch (scriptError) {
        throw new Error(
          `Invalid JavaScript near line ${
            scriptError.loc?.line ?? '?'
          }: ${scriptError.message}`
        );
      }
    }

    const imports = [];
    const functions = [];
    const calls = [];
    const functionNodeToName =
      new Map();

    walkJs(ast, (node, parent) => {
      if (
        node.type ===
        'ImportDeclaration'
      ) {
        imports.push({
          name: node.source.value,
          imported:
            node.specifiers
              .map(
                specifier =>
                  specifier.local?.name
              )
              .filter(Boolean)
        });
      }

      if (
        node.type === 'CallExpression' &&
        node.callee?.name === 'require' &&
        node.arguments?.[0]?.type ===
          'Literal'
      ) {
        imports.push({
          name: String(
            node.arguments[0].value
          ),
          imported: []
        });
      }

      if (
        [
          'FunctionDeclaration',
          'FunctionExpression',
          'ArrowFunctionExpression'
        ].includes(node.type)
      ) {
        const name =
          jsNodeName(node, parent);

        if (
          name !== '<anonymous>' ||
          parent?.type ===
            'VariableDeclarator' ||
          node.type ===
            'FunctionDeclaration'
        ) {
          const entry = {
            name,
            params:
              node.params.map(
                jsParamLabel
              ),
            output:
              jsReturnSummary(node),
            async: Boolean(node.async),
            line:
              node.loc?.start?.line ||
              null
          };

          functions.push(entry);
          functionNodeToName.set(
            node,
            name
          );
        }
      }
    });

    const known =
      new Set(
        functions.map(
          fn => fn.name
        )
      );

    walkJs(
      ast,
      (node, parent, ancestors) => {
        if (
          node.type !==
          'CallExpression'
        ) {
          return;
        }

        if (
          node.callee?.name ===
          'require'
        ) {
          return;
        }

        const callee =
          jsCalleeName(
            node.callee
          );

        if (!callee) {
          return;
        }

        const nearestFn =
          [...ancestors]
            .reverse()
            .find(
              ancestor =>
                functionNodeToName.has(
                  ancestor
                )
            );

        const from =
          nearestFn
            ? functionNodeToName.get(
                nearestFn
              )
            : '<module>';

        const direct =
          callee
            .split('.')
            .at(-1);

        const target =
          known.has(callee)
            ? callee
            : known.has(direct)
              ? direct
              : callee;

        calls.push({
          from,
          to: target,
          external:
            !known.has(target)
        });
      }
    );

    return dedupeAnalysis({
      language: 'JavaScript',
      imports,
      functions,
      calls
    });
  }

  /*
   * ==========================================================
   * Python analysis
   * ==========================================================
   */

  function stripPythonComment(line) {
    let quote = null;

    for (
      let i = 0;
      i < line.length;
      i += 1
    ) {
      const ch = line[i];

      if (
        (
          ch === '"' ||
          ch === "'"
        ) &&
        line[i - 1] !== '\\'
      ) {
        quote =
          quote === ch
            ? null
            : quote || ch;
      }

      if (
        ch === '#' &&
        !quote
      ) {
        return line.slice(0, i);
      }
    }

    return line;
  }

  function pythonIndent(line) {
    return line
      .match(/^[ \t]*/)[0]
      .replace(/\t/g, '    ')
      .length;
  }

  function validatePythonStructure(text) {
    const lines =
      text.split(/\r?\n/);

    const bracketStack = [];

    const pairs = {
      ')': '(',
      ']': '[',
      '}': '{'
    };

    let tripleQuote = null;

    for (
      let i = 0;
      i < lines.length;
      i += 1
    ) {
      const raw = lines[i];
      const lineNo = i + 1;

      const indentText =
        raw.match(/^\s*/)[0];

      if (
        /^\s*[\t ]+/.test(raw) &&
        indentText.includes('\t') &&
        indentText.includes(' ')
      ) {
        throw new Error(
          `Python indentation mixes tabs and spaces near line ${lineNo}.`
        );
      }

      let quote = null;

      for (
        let j = 0;
        j < raw.length;
        j += 1
      ) {
        const three =
          raw.slice(j, j + 3);

        if (
          !tripleQuote &&
          (
            three === "'''" ||
            three === '"""'
          )
        ) {
          tripleQuote = three;
          j += 2;
          continue;
        }

        if (
          tripleQuote &&
          three === tripleQuote
        ) {
          tripleQuote = null;
          j += 2;
          continue;
        }

        if (tripleQuote) {
          continue;
        }

        const ch = raw[j];

        if (
          (
            ch === '"' ||
            ch === "'"
          ) &&
          raw[j - 1] !== '\\'
        ) {
          quote =
            quote === ch
              ? null
              : quote || ch;

          continue;
        }

        if (quote) {
          continue;
        }

        if (ch === '#') {
          break;
        }

        if ('([{'.includes(ch)) {
          bracketStack.push({
            char: ch,
            line: lineNo
          });

          continue;
        }

        if (')]}'.includes(ch)) {
          const previous =
            bracketStack.pop();

          if (
            !previous ||
            previous.char !== pairs[ch]
          ) {
            throw new Error(
              `Mismatched bracket near Python line ${lineNo}.`
            );
          }
        }
      }
    }

    if (tripleQuote) {
      throw new Error(
        'Python source contains an unclosed triple-quoted string.'
      );
    }

    if (bracketStack.length) {
      const last =
        bracketStack.at(-1);

      throw new Error(
        `Python source contains an unclosed bracket beginning near line ${last.line}.`
      );
    }
  }

  function splitPythonParams(text) {
    const params = [];
    let current = '';
    let depth = 0;
    let quote = null;

    for (
      let i = 0;
      i < text.length;
      i += 1
    ) {
      const ch = text[i];

      if (
        (
          ch === '"' ||
          ch === "'"
        ) &&
        text[i - 1] !== '\\'
      ) {
        quote =
          quote === ch
            ? null
            : quote || ch;
      }

      if (!quote) {
        if ('([{'.includes(ch)) {
          depth += 1;
        }

        if (')]}'.includes(ch)) {
          depth -= 1;
        }

        if (
          ch === ',' &&
          depth === 0
        ) {
          if (current.trim()) {
            params.push(
              current.trim()
            );
          }

          current = '';
          continue;
        }
      }

      current += ch;
    }

    if (current.trim()) {
      params.push(current.trim());
    }

    return params;
  }

  function normalizePythonParam(param) {
    const cleaned =
      param.trim();

    if (!cleaned) {
      return '?';
    }

    const withoutDefault =
      cleaned
        .split('=')[0]
        .trim();

    if (
      withoutDefault === '/' ||
      withoutDefault === '*'
    ) {
      return withoutDefault;
    }

    if (withoutDefault.includes(':')) {
      return withoutDefault;
    }

    return `${withoutDefault}: unknown`;
  }

  function pythonReturnSummary(lines) {
    const types = new Set();

    for (const line of lines) {
      const trimmed =
        stripPythonComment(
          line
        ).trim();

      if (
        !trimmed.startsWith(
          'return'
        )
      ) {
        continue;
      }

      const expression =
        trimmed
          .slice(6)
          .trim();

      if (!expression) {
        types.add('None');
      } else if (
        /^["']/.test(expression)
      ) {
        types.add('str');
      } else if (
        /^(True|False)$/.test(
          expression
        )
      ) {
        types.add('bool');
      } else if (
        /^-?\d+(\.\d+)?$/.test(
          expression
        )
      ) {
        types.add(
          expression.includes('.')
            ? 'float'
            : 'int'
        );
      } else if (
        expression.startsWith('[')
      ) {
        types.add('list');
      } else if (
        expression.startsWith('{')
      ) {
        types.add('dict');
      } else if (
        expression.startsWith('(')
      ) {
        types.add('tuple/unknown');
      } else if (
        expression === 'None'
      ) {
        types.add('None');
      } else {
        types.add('unknown');
      }
    }

    return types.size
      ? [...types].join(' | ')
      : 'None/implicit';
  }

  function parsePythonImport(line) {
    const trimmed =
      stripPythonComment(
        line
      ).trim();

    let match =
      trimmed.match(
        /^import\s+(.+)$/
      );

    if (match) {
      return match[1]
        .split(',')
        .map(part =>
          part.trim()
        )
        .filter(Boolean)
        .map(part => {
          const chunks =
            part.split(
              /\s+as\s+/
            );

          return {
            name:
              chunks[0].trim(),
            imported: []
          };
        });
    }

    match =
      trimmed.match(
        /^from\s+([.\w]+)\s+import\s+(.+)$/
      );

    if (match) {
      const moduleName =
        match[1];

      const names =
        match[2]
          .replace(/[()]/g, '')
          .split(',')
          .map(
            item =>
              item
                .trim()
                .split(
                  /\s+as\s+/
                )[0]
                .trim()
          )
          .filter(Boolean);

      return [{
        name: moduleName,
        imported: names
      }];
    }

    return [];
  }

  function pythonCallNames(line) {
    const cleaned =
      stripPythonComment(line);

    const calls = [];
    const regex =
      /\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;

    let match;

    while (
      (
        match =
          regex.exec(cleaned)
      )
    ) {
      const name =
        match[1];

      if (
        [
          'if',
          'for',
          'while',
          'return',
          'yield',
          'with',
          'assert',
          'lambda',
          'print'
        ].includes(name)
      ) {
        continue;
      }

      calls.push(name);
    }

    return calls;
  }

  function analyzePython(text) {
    validatePythonStructure(text);

    const lines =
      text.split(/\r?\n/);

    const imports = [];
    const functions = [];
    const calls = [];

    const functionRanges = [];

    for (
      let i = 0;
      i < lines.length;
      i += 1
    ) {
      const raw =
        lines[i];

      const trimmed =
        stripPythonComment(
          raw
        ).trim();

      if (!trimmed) {
        continue;
      }

      const importEntries =
        parsePythonImport(raw);

      imports.push(
        ...importEntries
      );

      const match =
        trimmed.match(
          /^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*(?:->\s*([^:]+))?\s*:\s*$/
        );

      if (!match) {
        continue;
      }

      const isAsync =
        Boolean(match[1]);

      const name =
        match[2];

      const params =
        splitPythonParams(
          match[3]
        ).map(
          normalizePythonParam
        );

      const annotatedReturn =
        match[4]?.trim() ||
        null;

      const indent =
        pythonIndent(raw);

      let end =
        lines.length;

      for (
        let j = i + 1;
        j < lines.length;
        j += 1
      ) {
        const candidate =
          lines[j];

        if (!candidate.trim()) {
          continue;
        }

        if (
          pythonIndent(candidate) <=
            indent &&
          !candidate
            .trim()
            .startsWith('#')
        ) {
          end = j;
          break;
        }
      }

      const bodyLines =
        lines.slice(
          i + 1,
          end
        );

      const output =
        annotatedReturn ||
        pythonReturnSummary(
          bodyLines
        );

      functions.push({
        name,
        params,
        output,
        async: isAsync,
        line: i + 1
      });

      functionRanges.push({
        name,
        start: i,
        end,
        indent
      });
    }

    const known =
      new Set(
        functions.map(
          fn => fn.name
        )
      );

    for (
      let i = 0;
      i < lines.length;
      i += 1
    ) {
      const raw =
        lines[i];

      const trimmed =
        stripPythonComment(
          raw
        ).trim();

      if (!trimmed) {
        continue;
      }

      if (
        /^(async\s+)?def\s+/.test(
          trimmed
        )
      ) {
        continue;
      }

      const owner =
        functionRanges.find(
          range =>
            i > range.start &&
            i < range.end &&
            pythonIndent(raw) >
              range.indent
        );

      const from =
        owner
          ? owner.name
          : '<module>';

      const detectedCalls =
        pythonCallNames(raw);

      for (
        const callee of detectedCalls
      ) {
        const direct =
          callee
            .split('.')
            .at(-1);

        const target =
          known.has(callee)
            ? callee
            : known.has(direct)
              ? direct
              : callee;

        calls.push({
          from,
          to: target,
          external:
            !known.has(target)
        });
      }
    }

    return dedupeAnalysis({
      language: 'Python',
      imports,
      functions,
      calls
    });
  }

  /*
   * ==========================================================
   * Shared analysis
   * ==========================================================
   */

  function dedupeAnalysis(
    analysis
  ) {
    analysis.imports = [
      ...new Map(
        analysis.imports.map(
          item => [
            item.name,
            item
          ]
        )
      ).values()
    ];

    analysis.functions = [
      ...new Map(
        analysis.functions.map(
          item => [
            item.name,
            item
          ]
        )
      ).values()
    ];

    analysis.calls = [
      ...new Map(
        analysis.calls.map(
          item => [
            `${item.from}|${item.to}|${item.external}`,
            item
          ]
        )
      ).values()
    ];

    return analysis;
  }

  /*
   * ==========================================================
   * Mermaid generation
   * ==========================================================
   */

  function buildMermaid(
    analysis
  ) {
    const dir =
      els.direction.value;

    const showImports =
      els.showImports.checked;

    const showExternal =
      els.showExternal.checked;

    const showReturns =
      els.showReturns.checked;

    const lines = [
      `flowchart ${dir}`
    ];

    const ids =
      new Map();

    const moduleId =
      'module_root';

    lines.push(
      `  ${moduleId}["${escapeMermaid(
        sourceName ||
        `${analysis.language} source`
      )}"]`
    );

    analysis.functions.forEach(
      (fn, index) => {
        const id =
          safeId(
            'fn',
            fn.name,
            index
          );

        ids.set(
          fn.name,
          id
        );

        const params =
          fn.params.length
            ? fn.params.join(', ')
            : 'none';

        const output =
          showReturns
            ? ` · out: ${fn.output}`
            : '';

        const asyncLabel =
          fn.async
            ? 'async '
            : '';

        lines.push(
          `  ${id}["${escapeMermaid(
            `${fn.name}\\n${asyncLabel}in: ${params}${output}`
          )}"]`
        );
      }
    );

    if (showImports) {
      lines.push(
        '  subgraph imports_group["Imports / Packages"]'
      );

      analysis.imports.forEach(
        (imp, index) => {
          const id =
            safeId(
              'imp',
              imp.name,
              index
            );

          ids.set(
            `import:${imp.name}`,
            id
          );

          const details =
            imp.imported.length
              ? `\\n${imp.imported.join(', ')}`
              : '';

          lines.push(
            `    ${id}{{"${escapeMermaid(
              `${imp.name}${details}`
            )}"}}`
          );
        }
      );

      lines.push('  end');

      analysis.imports.forEach(
        imp => {
          lines.push(
            `  ${moduleId} -. imports .-> ${
              ids.get(
                `import:${imp.name}`
              )
            }`
          );
        }
      );
    }

    analysis.functions.forEach(
      fn => {
        lines.push(
          `  ${moduleId} --> ${
            ids.get(fn.name)
          }`
        );
      }
    );

    const externalIds =
      new Map();

    analysis.calls.forEach(
      (call, index) => {
        if (
          call.external &&
          !showExternal
        ) {
          return;
        }

        const fromId =
          call.from === '<module>'
            ? moduleId
            : ids.get(
                call.from
              );

        if (!fromId) {
          return;
        }

        let toId =
          ids.get(
            call.to
          );

        if (
          !toId &&
          call.external
        ) {
          if (
            !externalIds.has(
              call.to
            )
          ) {
            toId =
              safeId(
                'ext',
                call.to,
                index
              );

            externalIds.set(
              call.to,
              toId
            );

            lines.push(
              `  ${toId}(["${escapeMermaid(
                call.to
              )}"])`
            );
          } else {
            toId =
              externalIds.get(
                call.to
              );
          }
        }

        if (
          toId &&
          fromId !== toId
        ) {
          lines.push(
            `  ${fromId} -->|calls| ${toId}`
          );
        }
      }
    );

    lines.push(
      '  classDef module fill:#172554,stroke:#60a5fa,color:#eff6ff,stroke-width:2px;'
    );

    lines.push(
      '  classDef function fill:#ecfeff,stroke:#0891b2,color:#083344;'
    );

    lines.push(
      '  classDef external fill:#fff7ed,stroke:#ea580c,color:#7c2d12,stroke-dasharray: 4 3;'
    );

    lines.push(
      '  classDef import fill:#f0fdf4,stroke:#16a34a,color:#14532d;'
    );

    lines.push(
      `  class ${moduleId} module;`
    );

    if (
      analysis.functions.length
    ) {
      lines.push(
        `  class ${
          analysis.functions
            .map(
              fn =>
                ids.get(fn.name)
            )
            .join(',')
        } function;`
      );
    }

    if (
      externalIds.size
    ) {
      lines.push(
        `  class ${
          [...externalIds.values()]
            .join(',')
        } external;`
      );
    }

    if (
      showImports &&
      analysis.imports.length
    ) {
      lines.push(
        `  class ${
          analysis.imports
            .map(
              imp =>
                ids.get(
                  `import:${imp.name}`
                )
            )
            .join(',')
        } import;`
      );
    }

    return lines.join('\n');
  }

  /*
   * ==========================================================
   * Rendering
   * ==========================================================
   */

  async function renderMermaid() {
    const code =
      els.mermaidSource
        .value
        .trim();

    if (!code) {
      return;
    }

    setStatus(
      'Rendering Mermaid diagram…',
      'working'
    );

    try {
      await mermaid.parse(code);

      const result =
        await mermaid.render(
          `graph-${Date.now()}`,
          code
        );

      lastSvg =
        result.svg;

      els.diagram.innerHTML =
        result.svg;

      els.diagramEmpty.hidden =
        true;

      els.downloadSvgBtn.disabled =
        false;

      els.fitBtn.disabled =
        false;

      setStatus(
        'Diagram rendered successfully.',
        'ok'
      );
    } catch (error) {
      els.diagram.innerHTML = '';

      els.diagramEmpty.hidden =
        false;

      els.diagramEmpty.textContent =
        'Mermaid could not render the current source.';

      lastSvg = '';

      els.downloadSvgBtn.disabled =
        true;

      els.fitBtn.disabled =
        true;

      setStatus(
        `Mermaid render error: ${
          error.message || error
        }`,
        'error'
      );
    }
  }

  async function analyze() {
    if (!sourceText.trim()) {
      return;
    }

    setStatus(
      `Validating and analyzing ${language()} source…`,
      'working'
    );

    try {
      lastAnalysis =
        language() ===
        'javascript'
          ? analyzeJavaScript(
              sourceText
            )
          : analyzePython(
              sourceText
            );

      updateMetrics(
        lastAnalysis
      );

      els.mermaidSource.value =
        buildMermaid(
          lastAnalysis
        );

      els.copyBtn.disabled =
        false;

      els.downloadMmdBtn.disabled =
        false;

      els.renderBtn.disabled =
        false;

      await renderMermaid();

      setStatus(
        `Analysis complete: ${
          lastAnalysis.functions.length
        } functions, ${
          lastAnalysis.imports.length
        } imports, ${
          lastAnalysis.calls.length
        } call relationships.`,
        'ok'
      );
    } catch (error) {
      lastAnalysis = null;

      resetMetrics();

      els.mermaidSource.value =
        '';

      els.diagram.innerHTML =
        '';

      els.diagramEmpty.hidden =
        false;

      els.diagramEmpty.textContent =
        'Analysis stopped because the selected source was invalid or unsupported.';

      [
        els.copyBtn,
        els.downloadMmdBtn,
        els.downloadSvgBtn,
        els.renderBtn,
        els.fitBtn
      ].forEach(
        button => {
          button.disabled = true;
        }
      );

      setStatus(
        error.message ||
        String(error),
        'error'
      );
    }
  }

  /*
   * ==========================================================
   * Downloads / utilities
   * ==========================================================
   */

  function downloadText(
    filename,
    text,
    type = 'text/plain'
  ) {
    const blob =
      new Blob(
        [text],
        { type }
      );

    const url =
      URL.createObjectURL(
        blob
      );

    const a =
      document.createElement(
        'a'
      );

    a.href = url;
    a.download = filename;

    document.body.appendChild(
      a
    );

    a.click();
    a.remove();

    URL.revokeObjectURL(
      url
    );
  }

  function clearAll() {
    sourceText = '';
    sourceName = '';
    lastAnalysis = null;
    lastSvg = '';

    els.fileInput.value = '';

    els.fileName.textContent =
      'No file loaded';

    els.analyzeBtn.disabled =
      true;

    els.mermaidSource.value =
      '';

    els.diagram.innerHTML =
      '';

    els.diagramEmpty.hidden =
      false;

    els.diagramEmpty.textContent =
      'Analyze a file to render its dependency graph.';

    resetMetrics();

    [
      els.copyBtn,
      els.downloadMmdBtn,
      els.downloadSvgBtn,
      els.renderBtn,
      els.fitBtn
    ].forEach(
      button => {
        button.disabled = true;
      }
    );

    setStatus(
      'Cleared. Choose JavaScript or Python, then load a file.',
      'idle'
    );
  }

  function loadDemo() {
    const lang =
      language();

    if (
      lang ===
      'javascript'
    ) {
      sourceName =
        'demo.js';

      sourceText =
`import { parse } from 'n3';
import saveAs from 'file-saver';

function normalizeLabel(label) {
  return label.trim().toLowerCase();
}

function buildIndex(rows) {
  const index = new Map();
  rows.forEach(row => index.set(normalizeLabel(row.label), row));
  return index;
}

async function exportReport(rows) {
  const index = buildIndex(rows);
  const ttl = parse(String(index.size));
  saveAs(ttl);
  return ttl;
}
`;
    } else {
      sourceName =
        'demo.py';

      sourceText =
`import json
from pathlib import Path

def normalize_label(label: str) -> str:
    return label.strip().lower()

def build_index(rows: list) -> dict:
    index = {}
    for row in rows:
        index[normalize_label(row["label"])] = row
    return index

def export_report(rows: list) -> str:
    index = build_index(rows)
    text = json.dumps(index)
    Path("report.json").write_text(text)
    return text
`;
    }

    els.fileName.textContent =
      `${sourceName} · built-in demo`;

    els.analyzeBtn.disabled =
      false;

    setStatus(
      `Loaded ${lang} demo source.`,
      'ok'
    );

    analyze();
  }

  /*
   * ==========================================================
   * Events
   * ==========================================================
   */

  els.fileInput.addEventListener(
    'change',
    event => {
      const [file] =
        event.target.files;

      if (file) {
        readFile(file)
          .catch(
            error =>
              setStatus(
                error.message,
                'error'
              )
          );
      }
    }
  );

  [
    'dragenter',
    'dragover'
  ].forEach(
    type =>
      els.dropZone.addEventListener(
        type,
        event => {
          event.preventDefault();

          els.dropZone.classList.add(
            'dragover'
          );
        }
      )
  );

  [
    'dragleave',
    'drop'
  ].forEach(
    type =>
      els.dropZone.addEventListener(
        type,
        event => {
          event.preventDefault();

          els.dropZone.classList.remove(
            'dragover'
          );
        }
      )
  );

  els.dropZone.addEventListener(
    'drop',
    event => {
      const [file] =
        event.dataTransfer.files;

      if (file) {
        readFile(file)
          .catch(
            error =>
              setStatus(
                error.message,
                'error'
              )
          );
      }
    }
  );

  document
    .querySelectorAll(
      'input[name="language"]'
    )
    .forEach(
      radio =>
        radio.addEventListener(
          'change',
          () => {
            if (sourceText) {
              setStatus(
                `Language changed to ${language()}. Re-run analysis to validate the file as that language.`,
                'idle'
              );
            }
          }
        )
    );

  [
    els.showImports,
    els.showExternal,
    els.showReturns,
    els.direction
  ].forEach(
    control =>
      control.addEventListener(
        'change',
        () => {
          if (!lastAnalysis) {
            return;
          }

          els.mermaidSource.value =
            buildMermaid(
              lastAnalysis
            );

          renderMermaid();
        }
      )
  );

  els.analyzeBtn.addEventListener(
    'click',
    analyze
  );

  els.clearBtn.addEventListener(
    'click',
    clearAll
  );

  els.loadDemoBtn.addEventListener(
    'click',
    loadDemo
  );

  els.renderBtn.addEventListener(
    'click',
    renderMermaid
  );

  els.copyBtn.addEventListener(
    'click',
    async () => {
      try {
        await navigator.clipboard.writeText(
          els.mermaidSource.value
        );

        setStatus(
          'Mermaid source copied to clipboard.',
          'ok'
        );
      } catch {
        els.mermaidSource.select();

        document.execCommand(
          'copy'
        );

        setStatus(
          'Mermaid source copied using the fallback clipboard method.',
          'ok'
        );
      }
    }
  );

  els.downloadMmdBtn.addEventListener(
    'click',
    () =>
      downloadText(
        `${sourceName || 'diagram'}.mmd`,
        els.mermaidSource.value
      )
  );

  els.downloadSvgBtn.addEventListener(
    'click',
    () =>
      downloadText(
        `${sourceName || 'diagram'}.svg`,
        lastSvg,
        'image/svg+xml'
      )
  );

  els.fitBtn.addEventListener(
    'click',
    () => {
      const svg =
        els.diagram.querySelector(
          'svg'
        );

      if (!svg) {
        return;
      }

      svg.style.maxWidth =
        '100%';

      svg.style.width =
        '100%';

      setStatus(
        'Diagram fitted to the available width.',
        'ok'
      );
    }
  );
})();
