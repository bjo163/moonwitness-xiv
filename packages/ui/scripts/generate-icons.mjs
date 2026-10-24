import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { stdout } from 'node:process';
import { parseIconSvg } from './icon-svg-to-jsx.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = resolve(root, '../assets/icons');
const output = resolve(root, 'src/icons');
const files = (await readdir(assets)).filter((file) => file.endsWith('.svg')).sort();
const exports = [];
const exportLines = [];

function pascalCase(value) {
  return value.replace(/(^|-)([a-z])/gu, (_match, _separator, letter) => letter.toUpperCase());
}

await mkdir(output, { recursive: true });
for (const file of files) {
  const name = file.slice(0, -4);
  const component = `${pascalCase(name)}Icon`;
  const source = await readFile(resolve(assets, file), 'utf8');
  const { attributes: svgAttributes, children } = parseIconSvg(source, `assets/icons/${file}`);
  const rootProps = Object.entries(svgAttributes)
    .filter(
      ([attribute]) =>
        !['xmlns', 'viewBox', 'width', 'height', 'role', 'aria-label', 'aria-labelledby'].includes(
          attribute
        )
    )
    .map(([attribute, value]) => {
      const jsxAttribute = attribute.replace(/-([a-z])/gu, (_match, letter) =>
        letter.toUpperCase()
      );
      return `${jsxAttribute}=${JSON.stringify(value)}`;
    })
    .join('\n      ');
  exports.push(component);
  exportLines.push(`export { ${component} } from './${name}.js';`);

  await writeFile(
    resolve(output, `${name}.tsx`),
    `import { useId, type SVGProps } from 'react';

export type ${component}Props = Omit<SVGProps<SVGSVGElement>, 'children' | 'title'> & {
  title?: string;
  size?: number | string;
};

export function ${component}({ size = 24, title, ...props }: ${component}Props) {
  const titleId = useId();
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
      height={size}
      role={title ? 'img' : undefined}
      ${rootProps}
      viewBox=${JSON.stringify(svgAttributes.viewBox)}
      width={size}
      {...props}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      ${children}
    </svg>
  );
}
`
  );
}

await writeFile(resolve(output, 'index.ts'), `${exportLines.join('\n')}\n`);
stdout.write(`Generated ${exports.length} individually importable typed React icons.\n`);
