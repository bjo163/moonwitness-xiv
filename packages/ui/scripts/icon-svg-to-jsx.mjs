const ELEMENTS = new Set(['svg', 'g', 'circle', 'path', 'rect', 'line', 'polyline', 'polygon']);
const PRESENTATION_ATTRIBUTES = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'role',
  'aria-label',
  'aria-labelledby',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-rule',
  'clip-rule',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'stroke-opacity',
  'fill-opacity',
  'opacity',
  'transform',
  'vector-effect',
  'shape-rendering',
  'preserveAspectRatio',
]);

function decodeXml(value) {
  return value.replace(/&(amp|quot|apos|lt|gt);/gu, (_entity, name) => {
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[name];
  });
}

function jsxAttributeName(name) {
  if (name === 'viewBox' || name === 'preserveAspectRatio') return name;
  return name.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const MARKER_LITERALS = [COMMENT_OPEN, COMMENT_CLOSE, '--!>'];
const TITLE_OPEN_PATTERN = /<title\b[^>]*>/giu;
const TITLE_CLOSE_PATTERN = /<\/title\s*>/giu;

function matchFrom(pattern, source, start) {
  pattern.lastIndex = start;
  const match = pattern.exec(source);
  return match && match.index >= start ? match : null;
}

/**
 * Comments and titles are removed by slicing between literal markers rather than by replacing a
 * pattern, so no removal can splice two surviving halves into a new marker. The accumulated output
 * is still re-checked against every marker spelling, and an unterminated comment fails the build
 * instead of reaching the generated component.
 */
function stripMarkup(source, fileName) {
  const fail = () => {
    throw new Error(
      `${fileName}: unclosed SVG comment marker; close or remove the comment before generating.`
    );
  };
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const commentStart = source.indexOf(COMMENT_OPEN, cursor);
    const titleOpen = matchFrom(TITLE_OPEN_PATTERN, source, cursor);
    const starts = [commentStart, titleOpen ? titleOpen.index : -1].filter((index) => index !== -1);
    if (starts.length === 0) {
      output += source.slice(cursor);
      break;
    }
    const start = Math.min(...starts);
    output += source.slice(cursor, start);
    if (start === commentStart) {
      const end = source.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN.length);
      if (end === -1) fail();
      cursor = end + COMMENT_CLOSE.length;
      continue;
    }
    const close = matchFrom(TITLE_CLOSE_PATTERN, source, start + titleOpen[0].length);
    if (!close) {
      output += titleOpen[0];
      cursor = start + titleOpen[0].length;
      continue;
    }
    cursor = close.index + close[0].length;
  }
  if (MARKER_LITERALS.some((marker) => output.includes(marker))) fail();
  return output.trim();
}

function parseAttributes(source, fileName) {
  const attributes = {};
  let remainder = source;
  const attributePattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of source.matchAll(attributePattern)) {
    const [whole, name, doubleQuoted, singleQuoted] = match;
    if (Object.hasOwn(attributes, name)) {
      throw new Error(`${fileName}: duplicate SVG attribute "${name}" is not supported.`);
    }
    if (/^on/iu.test(name) || name === 'style') {
      throw new Error(`${fileName}: unsafe or generated SVG attribute "${name}" is not supported.`);
    }
    if (['id', 'mask', 'clip-path'].includes(name)) {
      throw new Error(
        `${fileName}: SVG IDs and mask/clip references are not supported in generated icons; flatten the source paths first.`
      );
    }
    attributes[name] = decodeXml(doubleQuoted ?? singleQuoted ?? '');
    remainder = remainder.replace(whole, '');
  }
  if (remainder.trim()) {
    throw new Error(`${fileName}: malformed SVG attributes: ${remainder.trim()}`);
  }
  return attributes;
}

function renderNode(node) {
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => `${jsxAttributeName(name)}=${JSON.stringify(value)}`)
    .join(' ');
  const props = attributes ? ` ${attributes}` : '';
  if (node.children.length === 0) return `<${node.name}${props} />`;
  return `<${node.name}${props}>${node.children.map(renderNode).join('')}</${node.name}>`;
}

export function parseIconSvg(source, fileName = '<icon>') {
  const svg = stripMarkup(
    source.replace(/^\uFEFF/u, '').replace(/<\?xml[^>]*\?>/giu, ''),
    fileName
  );
  const tokens = [...svg.matchAll(/<\/?[A-Za-z][\w:-]*\b[^>]*>/gu)];
  if (tokens.length === 0) {
    throw new Error(`${fileName}: expected one SVG root with supported vector shapes.`);
  }

  const root = { name: 'svg', attributes: {}, children: [] };
  const stack = [];
  let cursor = 0;
  let rootSeen = false;

  for (const token of tokens) {
    if (svg.slice(cursor, token.index).trim()) {
      throw new Error(`${fileName}: text nodes are not supported in interface icons.`);
    }
    cursor = token.index + token[0].length;
    const value = token[0];
    const closing = /^<\//u.test(value);
    const selfClosing = /\/\s*>$/u.test(value);
    const name = value.match(/^<\/?([A-Za-z][\w:-]*)/u)?.[1];
    if (!name || !ELEMENTS.has(name)) {
      throw new Error(`${fileName}: unsupported SVG element "${name ?? 'unknown'}".`);
    }

    if (closing) {
      if (selfClosing || stack.at(-1)?.name !== name) {
        throw new Error(`${fileName}: unexpected closing SVG element "${name}".`);
      }
      stack.pop();
      continue;
    }

    const attributeText = value
      .slice(name.length + 1, value.length - (selfClosing ? value.match(/\/\s*>$/u)[0].length : 1))
      .trim();
    const attributes = parseAttributes(attributeText, fileName);
    if (name === 'svg') {
      if (rootSeen || stack.length !== 0) {
        throw new Error(`${fileName}: nested or multiple SVG roots are not supported.`);
      }
      for (const attribute of Object.keys(attributes)) {
        if (!PRESENTATION_ATTRIBUTES.has(attribute)) {
          throw new Error(
            `${fileName}: unsupported SVG root attribute "${attribute}"; add an explicit generator mapping first.`
          );
        }
      }
      if (!attributes.viewBox) {
        throw new Error(`${fileName}: SVG root must declare a viewBox.`);
      }
      Object.assign(root.attributes, attributes);
      rootSeen = true;
      if (!selfClosing) stack.push(root);
      continue;
    }

    if (!rootSeen || stack.length === 0) {
      throw new Error(`${fileName}: vector element "${name}" must be inside the SVG root.`);
    }
    const node = { name, attributes, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (svg.slice(cursor).trim() || stack.length !== 0 || !rootSeen) {
    throw new Error(`${fileName}: SVG elements are malformed or not fully closed.`);
  }
  if (root.children.length === 0) {
    throw new Error(`${fileName}: SVG must contain at least one supported vector shape.`);
  }
  return {
    attributes: root.attributes,
    children: root.children.map(renderNode).join('\n      '),
  };
}
