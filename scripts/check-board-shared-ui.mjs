import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'apps/board/src');
const replacements = {
  button: 'Button from @moonwitness/ui/components/button',
  input:
    'Input or Checkbox from @moonwitness/ui/components/input or @moonwitness/ui/components/checkbox',
  select: 'SelectField from @moonwitness/ui/components/select-field',
  textarea: 'Textarea from @moonwitness/ui/components/textarea',
};

export function findBoardUiViolations(source, file = 'apps/board/src/fixture.tsx') {
  const violations = [];
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const report = (node, rule, detail) => {
    const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    violations.push(`${file}:${line + 1}: ${rule}${detail ? ` (${detail})` : ''}`);
  };
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text in replacements
    ) {
      report(
        node.tagName,
        `raw JSX <${node.tagName.text}> is not allowed`,
        `use ${replacements[node.tagName.text]}; then run pnpm board:ui:check`
      );
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        /^@moonwitness\/ui\/dist(?:\/|$)/u.test(specifier.text)
      ) {
        report(
          specifier,
          'internal @moonwitness/ui dist import is not allowed',
          'use the public @moonwitness/ui subpath; then run pnpm board:ui:check'
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [argument] = node.arguments;
      if (
        argument &&
        ts.isStringLiteral(argument) &&
        /^@moonwitness\/ui\/dist(?:\/|$)/u.test(argument.text)
      ) {
        report(
          argument,
          'internal @moonwitness/ui dist import is not allowed',
          'use the public @moonwitness/ui subpath; then run pnpm board:ui:check'
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return violations;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(file);
        return entry.isFile() && /\.[jt]sx?$/u.test(entry.name) ? [file] : [];
      })
    )
  ).flat();
}

async function main() {
  const violations = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    violations.push(...findBoardUiViolations(await readFile(file, 'utf8'), relative));
  }

  if (violations.length) {
    console.error(`Board shared UI check failed with ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      'Fix: replace native controls with shared UI components and import only public package subpaths. Recheck with `pnpm board:ui:check`.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    'Board shared UI check passed: no native controls or internal UI package imports found.'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
