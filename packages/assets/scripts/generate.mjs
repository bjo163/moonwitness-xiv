import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { replaceGeneratedAssets } from './manifest-ownership.mjs';
import sharp from 'sharp';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brandDirectory = resolve(packageRoot, 'brand');
const brandMaster = await readFile(
  resolve(brandDirectory, 'source/moonwitness-master.svg'),
  'utf8'
);

function masterGroup(id, color, transform = '') {
  const match = brandMaster.match(
    new RegExp(
      `<g id="mw-brand-source-moonwitness-master-svg-${id}"([^>]*)>([\\s\\S]*?)<\\/g>`,
      'u'
    )
  );
  if (!match) throw new Error(`Canonical brand master is missing the ${id} group`);
  const sourceTransform = match[1].match(/\btransform="([^"]+)"/u)?.[1];
  const source = `<g${sourceTransform ? ` transform="${sourceTransform}"` : ''}>${match[2]}</g>`;
  const dataAttribute = id === 'wordmark' ? ' data-brand-wordmark="true"' : '';
  return `<g${dataAttribute}${transform ? ` transform="${transform}"` : ''} fill="${color}">${source}</g>`;
}

const palettes = {
  light: { ink: '#0d0d0d', paper: '#f3efe4', accent: '#ffe031' },
  dark: { ink: '#f3efe4', paper: '#0e0e10', accent: '#ffe031' },
  'mono-light': { ink: '#0d0d0d', paper: '#fffdf6', accent: '#0d0d0d' },
  'mono-dark': { ink: '#fffdf6', paper: '#0e0e10', accent: '#fffdf6' },
};

const mark = (palette) => masterGroup('crown', palette.accent);
const wordmark = (palette, transform = '') => masterGroup('wordmark', palette.ink, transform);

function svgDocument(viewBox, title, content, width, height, attributes = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}"${attributes} role="img" aria-label="${title}">
  <title>${title}</title>
${content}
</svg>\n`;
}

const icons = [
  {
    name: 'user',
    title: 'User',
    paths:
      '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c.7-3.4 3.4-5.5 7.5-5.5s6.8 2.1 7.5 5.5"/>',
  },
  {
    name: 'users',
    title: 'Users',
    paths:
      '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3.5 20c.4-3.2 2.2-5 5.5-5s5.1 1.8 5.5 5m.5-4.5c3.3 0 5 1.6 5.5 4.5"/>',
  },
  {
    name: 'document',
    title: 'Document',
    paths:
      '<path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5v5h5M8 12h8m-8 3.5h8"/>',
  },
  {
    name: 'knowledge',
    title: 'Knowledge',
    paths:
      '<path d="M4 5.5c3.2-1.2 5.8-.8 8 1.2 2.2-2 4.8-2.4 8-1.2v14c-3.2-1.2-5.8-.8-8 1.2-2.2-2-4.8-2.4-8-1.2v-14Z"/><path d="M12 6.7v14m-5-11h2m6 0h2"/>',
  },
  {
    name: 'image',
    title: 'Image',
    paths:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="9" r="1.5"/><path d="m5 17 5-5 3.5 3 2.5-2 3 4"/>',
  },
  {
    name: 'partner',
    title: 'Partner contact',
    paths:
      '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-2.9 2.5-4.5 5.5-4.5 2.2 0 3.8.9 4.7 2.6"/><rect x="14" y="5" width="6.5" height="11" rx="1"/><path d="M15.7 8h3.1m-3.1 2.7h3.1m-3.1 2.7h1.7"/><path d="M15.5 20h4"/>',
  },
  {
    name: 'company',
    title: 'Company',
    paths:
      '<path d="M3.5 20V8.5L10 5.5V20Z M10 11L20.5 7V20H10Z M3.5 20H20.5"/><path d="M6.5 10.5v1m0 3v1m6-2v1m0 3v1m4.5-8v1m0 3v1m0 3v1"/>',
  },
  {
    name: 'team',
    title: 'Team',
    paths:
      '<circle cx="12" cy="7" r="2.8"/><circle cx="5" cy="9" r="2.1"/><circle cx="19" cy="9" r="2.1"/><path d="M7 19c.4-3.2 2-4.8 5-4.8s4.6 1.6 5 4.8m-14.5-.5c.3-2.3 1.3-3.5 3.2-3.8m13.8 3.8c-.3-2.3-1.3-3.5-3.2-3.8"/>',
  },
  {
    name: 'addon',
    title: 'Addon module',
    paths:
      '<path d="M4 4h6v3a2 2 0 1 0 4 0V4h6v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H4v-6h3a2 2 0 1 0 0-4H4V4Z"/>',
  },
  {
    name: 'model',
    title: 'Data model',
    paths:
      '<rect x="3.5" y="4" width="17" height="16" rx="1"/><path d="M3.5 9h17M9 9v11m6-11v11M3.5 14.5h17"/>',
  },
  {
    name: 'field',
    title: 'Model field',
    paths: '<path d="M4 5h16M4 9h9m-9 4h16m-16 4h10"/><circle cx="18" cy="9" r="1"/>',
  },
  {
    name: 'relation',
    title: 'Model relation',
    paths:
      '<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="m7.4 11 9.2-4m-9.2 6 9.2 4"/>',
  },
  {
    name: 'activity',
    title: 'Activity',
    paths: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2m-11-9 2-1.5m13 1.5-2-1.5"/>',
  },
  {
    name: 'calendar-clock',
    title: 'Scheduled activity',
    paths:
      '<rect x="3.5" y="5" width="17" height="16" rx="1.5"/><path d="M7.5 3v4m9-4v4m-13 2h8"/><circle cx="16.5" cy="16" r="3.5"/><path d="M16.5 14.5V16l1.1.7"/>',
  },
  {
    name: 'attachment',
    title: 'Attachment',
    paths:
      '<path d="m8.5 12.5 6.8-6.8a3.2 3.2 0 0 1 4.5 4.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6"/><path d="m7.1 13.9 7.8-7.8"/>',
  },
  {
    name: 'notification',
    title: 'Notification',
    paths:
      '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4"/><path d="M12 3V1.8"/>',
  },
  {
    name: 'inbox',
    title: 'Notification inbox',
    paths: '<path d="M4 4.5h16l2 10v5H2v-5l2-10Z"/><path d="M2.5 14h5l1.7 3h5.6l1.7-3h5"/>',
  },
  {
    name: 'jobs',
    title: 'Background jobs',
    paths:
      '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M9 4V2.5h6V4m-7 5h8m-8 4h8m-8 4h4"/>',
  },
  {
    name: 'workflow',
    title: 'Workflow',
    paths:
      '<rect x="3.5" y="3.5" width="6" height="5" rx="1"/><rect x="14.5" y="15.5" width="6" height="5" rx="1"/><circle cx="17.5" cy="6" r="2.5"/><path d="M9.5 6h3.5a4.5 4.5 0 0 1 4.5 4.5v5m-14-7v4.5a3.5 3.5 0 0 0 3.5 3.5h7.5"/>',
  },
  {
    name: 'security',
    title: 'Security policy',
    paths:
      '<path d="M12 3 20 6v5.5c0 4.6-3 7.6-8 9.5-5-1.9-8-4.9-8-9.5V6l8-3Z"/><path d="m8.5 12 2.3 2.3 4.8-5"/>',
  },
  {
    name: 'mail',
    title: 'Email',
    paths: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="m4 6 8 6 8-6"/>',
  },
  {
    name: 'phone',
    title: 'Phone call',
    paths:
      '<path d="M7.2 3.5h3l1.4 4.1-2.1 1.8a15.6 15.6 0 0 0 5.1 5.1l1.8-2.1 4.1 1.4v3a2 2 0 0 1-2.2 2A16.8 16.8 0 0 1 5.2 5.7a2 2 0 0 1 2-2.2Z"/>',
  },
  {
    name: 'lock',
    title: 'Password',
    paths:
      '<rect x="4.5" y="10" width="15" height="11" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  },
  {
    name: 'visibility',
    title: 'Show password',
    paths:
      '<path d="M2.5 12s3.2-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.2 5.5-9.5 5.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  },
  {
    name: 'visibility-off',
    title: 'Hide password',
    paths:
      '<path d="m3 3 18 18M10.6 6.6c.5-.1.9-.1 1.4-.1 6.3 0 9.5 5.5 9.5 5.5a16 16 0 0 1-3 3.7M6.2 6.8C3.8 8.3 2.5 12 2.5 12s3.2 5.5 9.5 5.5c.8 0 1.6-.1 2.3-.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  },
  {
    name: 'check',
    title: 'Check',
    paths: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  },
  {
    name: 'check-square',
    title: 'Task complete',
    paths: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="m7.5 12.5 3 3 6-7"/>',
  },
  {
    name: 'warning',
    title: 'Warning',
    paths: '<path d="M12 3.5 22 20H2L12 3.5Z"/><path d="M12 9v5m0 3h.01"/>',
  },
  {
    name: 'error',
    title: 'Error',
    paths: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  },
  {
    name: 'info',
    title: 'Information',
    paths: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  },
  {
    name: 'search',
    title: 'Search',
    paths: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  },
  {
    name: 'close',
    title: 'Close',
    paths: '<path d="m6 6 12 12M18 6 6 18"/>',
  },
  {
    name: 'add',
    title: 'Add',
    paths: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10m-5-5h10"/>',
  },
  {
    name: 'edit',
    title: 'Edit',
    paths:
      '<path d="m14.5 5.5 4 4M4 20l4.5-1 10.8-10.8a2.8 2.8 0 0 0-4-4L4.5 15 4 20Z"/><path d="M13 20h7"/>',
  },
  {
    name: 'save',
    title: 'Save',
    paths:
      '<path d="M5 3.5h12l3.5 3.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M8 3.5v5h8v-5M8 21v-8h8v8"/>',
  },
  {
    name: 'delete',
    title: 'Delete',
    paths: '<path d="M4 7h16m-10-3h4m-8 3 1 13h10l1-13m-8 3v7m4-7v7"/>',
  },
  {
    name: 'settings',
    title: 'Settings',
    paths:
      '<path d="M12 3.5v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.5-6-1.4 1.4m-9.2 9.2L6 18m12 0-1.4-1.4m-9.2-9.2L6 6"/><circle cx="12" cy="12" r="6.3"/><circle cx="12" cy="12" r="2"/>',
  },
  {
    name: 'calendar',
    title: 'Calendar',
    paths:
      '<rect x="3.5" y="5" width="17" height="16" rx="1.5"/><path d="M7.5 3v4m9-4v4m-13 2h17m-12 4h.1m4.9 0h.1m-5.1 4h.1m4.9 0h.1"/>',
  },
  {
    name: 'filter',
    title: 'Filter',
    paths: '<path d="M3.5 5h17l-6.5 7v5l-4 2v-7L3.5 5Z"/>',
  },
  {
    name: 'sort',
    title: 'Sort',
    paths: '<path d="M8 5v14m-4-4 4 4 4-4M16 19V5m-4 4 4-4 4 4"/>',
  },
  {
    name: 'upload',
    title: 'Upload',
    paths: '<path d="M12 16V4m-5 5 5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  },
  {
    name: 'download',
    title: 'Download',
    paths: '<path d="M12 4v12m-5-5 5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  },
  {
    name: 'refresh',
    title: 'Refresh',
    paths:
      '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2"/>',
  },
  {
    name: 'external-link',
    title: 'Open external link',
    paths:
      '<path d="M13 4h7v7m0-7-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  },
  {
    name: 'menu',
    title: 'Menu',
    paths: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  },
  {
    name: 'home',
    title: 'Home',
    paths: '<path d="m3 11 9-7 9 7v9h-6v-6H9v6H3v-9Z"/>',
  },
  {
    name: 'arrow-right',
    title: 'Arrow right',
    paths: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  },
  {
    name: 'chevron-right',
    title: 'Chevron right',
    paths: '<path d="m9 5 7 7-7 7"/>',
  },
  {
    name: 'globe',
    title: 'Globe',
    paths:
      '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z"/>',
  },
  {
    name: 'moon',
    title: 'Moon',
    paths: '<path d="M19.5 15.5A8.5 8.5 0 0 1 8.5 4.5a8.5 8.5 0 1 0 11 11Z"/>',
  },
  {
    name: 'play',
    title: 'Play',
    paths: '<path d="m8 5 11 7-11 7V5Z"/>',
  },
  {
    name: 'pause',
    title: 'Pause',
    paths: '<path d="M8 5h3v14H8zm5 0h3v14h-3z"/>',
  },
  {
    name: 'volume',
    title: 'Volume',
    paths: '<path d="M4 10v4h4l5 4V6l-5 4H4Zm12-1a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12"/>',
  },
  {
    name: 'volume-off',
    title: 'Mute sound',
    paths: '<path d="M4 10v4h4l5 4V6l-5 4H4Zm11-1 6 6m0-6-6 6"/>',
  },
  {
    name: 'archive',
    title: 'Archive',
    paths: '<path d="M4 5h16v4H4zM6 9v11h12V9m-8 4h4"/>',
  },
  {
    name: 'book-open',
    title: 'Open book',
    paths:
      '<path d="M12 6c-2-2-5-2.5-9-1v14c4-1.5 7-1 9 1m0-14c2-2 5-2.5 9-1v14c-4-1.5-7-1-9 1m0-14v14"/>',
  },
  {
    name: 'story',
    title: 'Story',
    paths: '<path d="M5 4h14v16H5zM8 8h8m-8 4h8m-8 4h5"/>',
  },
  {
    name: 'signal',
    title: 'Signal',
    paths: '<path d="M4 18a11 11 0 0 1 16 0M7 15a7 7 0 0 1 10 0m-7-3a3 3 0 0 1 4 0m-2 6v.1"/>',
  },
  {
    name: 'signal-off',
    title: 'Signal disconnected',
    paths:
      '<path d="m3 3 18 18M8.5 8.5A11 11 0 0 0 4 18m5.5-5.5a7 7 0 0 0-2.4 2.4m6.2-6.2a7 7 0 0 1 4.7 2.2m-1.5-5.4A11 11 0 0 1 20 18m-8-1v.1"/>',
  },
  {
    name: 'smartphone',
    title: 'Smartphone',
    paths: '<rect x="6" y="2.5" width="12" height="19" rx="2"/><path d="M10 5h4m-4 13h4"/>',
  },
  {
    name: 'send',
    title: 'Send message',
    paths: '<path d="m21.5 2.5-7 19-4-8-8-4 19-7Z"/><path d="m10.5 13.5 5-5"/>',
  },
  {
    name: 'message',
    title: 'Message',
    paths:
      '<path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.8 8.8 0 0 1-3.4-.7L4 20l1.5-3.6A7.1 7.1 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z"/><path d="M8.5 12h.01m3.5 0h.01m3.5 0h.01"/>',
  },
  {
    name: 'code',
    title: 'Code',
    paths: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-2-15-4 18"/>',
  },
  {
    name: 'keyboard',
    title: 'Keyboard shortcuts',
    paths:
      '<rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M6 9h.01m3 0h.01m3 0h.01m3 0h.01m3 0h.01M6 12h.01m3 0h.01m3 0h.01m3 0h.01m3 0h.01M7 15h10"/>',
  },
  {
    name: 'logout',
    title: 'Sign out',
    paths: '<path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5m4-4 4-4-4-4m4 4H8"/>',
  },
  {
    name: 'sun',
    title: 'Sun',
    paths:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
  },
  {
    name: 'sparkle',
    title: 'Sparkle',
    paths:
      '<path d="m12 2 1.8 7.2L21 12l-7.2 1.8L12 21l-1.8-7.2L3 12l7.2-2.8L12 2Z"/><path d="m19 14 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z"/>',
  },
  {
    name: 'bank',
    title: 'Bank',
    paths: '<path d="m3 9 9-5 9 5M4 10h16M5 10v9m4-9v9m6-9v9m4-9v9M3 20h18M2.5 22h19"/>',
  },
  {
    name: 'bolt',
    title: 'Model action',
    paths: '<path d="m13 2-8 11h6l-1 9 9-12h-6l1-8Z"/>',
  },
  {
    name: 'chevrons-left',
    title: 'Previous page group',
    paths: '<path d="m17 5-7 7 7 7M9 5l-7 7 7 7"/>',
  },
  {
    name: 'chevrons-right',
    title: 'Next page group',
    paths: '<path d="m7 5 7 7-7 7m8-14 7 7-7 7"/>',
  },
  {
    name: 'columns',
    title: 'Table columns',
    paths: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M9 4v16m6-16v16"/>',
  },
  {
    name: 'grid',
    title: 'Grid view',
    paths:
      '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
  },
  {
    name: 'sort-ascending',
    title: 'Sort ascending',
    paths: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  },
  {
    name: 'sort-descending',
    title: 'Sort descending',
    paths: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  },
  {
    name: 'tag',
    title: 'Tag',
    paths:
      '<path d="m20.5 13.5-7 7a2 2 0 0 1-2.8 0l-7.2-7.2V3.5h9.8l7.2 7.2a2 2 0 0 1 0 2.8Z"/><circle cx="8" cy="8" r="1.25"/>',
  },
  {
    name: 'credit-card',
    title: 'Credit card',
    paths:
      '<rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M3 9h18m-15 6h4m-4 2h2"/>',
  },
  {
    name: 'currency',
    title: 'Currency',
    paths:
      '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5c-.7-.7-1.8-1-3-1-1.8 0-3 .9-3 2.2 0 3.2 5.8 1.2 5.8 4.4 0 1.3-1.2 2.4-3.2 2.4-1.2 0-2.5-.4-3.4-1.3M12 6v12"/>',
  },
  {
    name: 'hash',
    title: 'Sequence number',
    paths: '<path d="M9 3 6.5 21M17.5 3 15 21M4 9h16M3 15h16"/>',
  },
  {
    name: 'language',
    title: 'Language',
    paths:
      '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z"/><path d="m16 4 4 4m-1-4-4 4"/>',
  },
  {
    name: 'key',
    title: 'Access token',
    paths:
      '<circle cx="8" cy="15.5" r="4.5"/><path d="m11.2 12.3 9.3-9.3m-3.5 3.5 2.5 2.5m-5-0 2.5 2.5"/>',
  },
  {
    name: 'map-pin',
    title: 'Location',
    paths:
      '<path d="M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  },
];

const generated = [];
for (const [variant, palette] of Object.entries(palettes)) {
  const symbolName = `moonwitness-symbol-${variant}.svg`;
  const wordmarkName = `moonwitness-wordmark-${variant}.svg`;
  const lockupName = `moonwitness-lockup-${variant}.svg`;

  generated.push({
    path: `brand/${symbolName}`,
    kind: 'symbol',
    variant,
    width: 64,
    height: 64,
    svg: svgDocument('0 0 64 64', 'MoonWitness crown symbol', mark(palette), 64, 64),
  });
  generated.push({
    path: `brand/${wordmarkName}`,
    kind: 'wordmark',
    variant,
    width: 500,
    height: 80,
    svg: svgDocument(
      '0 0 500 80',
      'MoonWitness brush wordmark',
      wordmark(palette, 'translate(-68 0) skewX(5)'),
      500,
      80
    ),
  });
  generated.push({
    path: `brand/${lockupName}`,
    kind: 'lockup',
    variant,
    width: 520,
    height: 80,
    svg: svgDocument(
      '0 0 520 80',
      'MoonWitness crown and brush wordmark lockup',
      `<g transform="translate(4 8)">${mark(palette)}</g>${wordmark(palette)}`,
      520,
      80
    ),
  });
}

const favicon = svgDocument(
  '0 0 64 64',
  'MoonWitness favicon',
  `<rect width="64" height="64" rx="12" fill="#0d0d0d"/><g transform="translate(0 0)">${mark({ ink: '#fffdf6', paper: '#0d0d0d', accent: '#ffe031' })}</g>`,
  64,
  64
);
generated.push({
  path: 'brand/favicon.svg',
  kind: 'favicon',
  variant: 'dark-surface',
  width: 64,
  height: 64,
  svg: favicon,
});

const light = palettes.light;
const socialCard = svgDocument(
  '0 0 1200 630',
  'MoonWitness — one board for every model',
  `<rect width="1200" height="630" fill="${light.paper}"/>
  <circle id="mw-brand-social-card-orbit-outer" cx="1040" cy="312" r="228" fill="none" stroke="#0d0d0d" stroke-width="2" opacity=".16"/>
  <circle cx="1040" cy="312" r="176" fill="none" stroke="#0d0d0d" stroke-width="1.5" opacity=".12"/>
  <path d="M800 455c96-134 219-203 361-213M824 500c115-66 242-84 343-47" fill="none" stroke="#0d0d0d" stroke-width="2" opacity=".12"/>
  <g transform="translate(72 58) scale(.72)">${mark(light)}</g>
  <g transform="translate(132 68) scale(.58)">${wordmark(light, 'translate(-68 0)')}</g>
  <rect x="74" y="194" width="580" height="104" rx="4" fill="${light.accent}" transform="rotate(-1.2 74 194)"/>
  <text x="92" y="270" fill="${light.ink}" font-family="Arial Black, Arial, sans-serif" font-size="76" font-weight="900" letter-spacing="-2">ONE BOARD.</text>
  <text x="78" y="375" fill="${light.ink}" font-family="Arial Black, Arial, sans-serif" font-size="75" font-weight="900" letter-spacing="-2">EVERY MODEL.</text>
  <path d="M82 407h520" stroke="#ff2e88" stroke-width="6" stroke-linecap="round"/>
  <text x="82" y="464" fill="#3a3a36" font-family="Arial, Helvetica, sans-serif" font-size="27">A clear view of the records behind your work.</text>
  <text x="82" y="555" fill="#6b695f" font-family="Arial, Helvetica, sans-serif" font-size="19" letter-spacing="2">OPEN-SOURCE · EXTENSIBLE · SELF-HOSTED</text>
  <circle cx="1070" cy="118" r="8" fill="${light.accent}" stroke="#0d0d0d" stroke-width="2"/>
  <path d="M976 524l10 10m0-10-10 10m50-42v16m-8-8h16" fill="none" stroke="#0d0d0d" stroke-width="2" stroke-linecap="round"/>`,
  1200,
  630
);
generated.push({
  path: 'brand/social-card.svg',
  kind: 'social-card',
  variant: 'light',
  width: 1200,
  height: 630,
  svg: socialCard,
});

const readmeBanner = svgDocument(
  '0 0 1280 320',
  'MoonWitness — every model, every record, one board',
  `<rect width="1280" height="320" fill="${light.paper}"/>
  <path d="M0 252C232 186 365 295 601 221S1007 121 1280 201" fill="none" stroke="#0d0d0d" stroke-width="2" opacity=".12"/>
  <path d="M0 278C256 214 421 319 640 257S1032 157 1280 228" fill="none" stroke="#0d0d0d" stroke-width="1.5" opacity=".1"/>
  <g transform="translate(76 92)">${mark(light)}</g>
  <g transform="translate(154 96) scale(.7)">${wordmark(light, 'translate(-68 0)')}</g>
  <rect x="78" y="186" width="500" height="64" rx="3" fill="${light.accent}" transform="rotate(-.7 78 186)"/>
  <text x="92" y="232" fill="${light.ink}" font-family="Arial Black, Arial, sans-serif" font-size="37" font-weight="900">EVERY MODEL. ONE BOARD.</text>
  <text x="820" y="116" fill="#3a3a36" font-family="Arial, Helvetica, sans-serif" font-size="22">Composable business software</text>
  <text x="820" y="153" fill="#3a3a36" font-family="Arial, Helvetica, sans-serif" font-size="22">with a programmatic addon core.</text>
  <circle cx="1080" cy="230" r="56" fill="none" stroke="#0d0d0d" stroke-width="2" opacity=".3"/>
  <circle cx="1080" cy="230" r="38" fill="none" stroke="#0d0d0d" stroke-width="2" opacity=".2"/>
  <circle cx="1115" cy="196" r="7" fill="${light.accent}" stroke="#0d0d0d" stroke-width="2"/>`,
  1280,
  320
);
generated.push({
  path: 'brand/readme-banner.svg',
  kind: 'readme-banner',
  variant: 'light',
  width: 1280,
  height: 320,
  svg: readmeBanner,
});

for (const icon of icons) {
  generated.push({
    path: `icons/${icon.name}.svg`,
    kind: 'icon',
    variant: 'currentColor',
    width: 24,
    height: 24,
    svg: svgDocument(
      '0 0 24 24',
      icon.title,
      icon.paths,
      24,
      24,
      ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    ),
  });
}

await mkdir(brandDirectory, { recursive: true });
for (const asset of generated) {
  const optimizedSvg = `${asset.svg.replace(/>\s+</gu, '><').trim()}\n`;
  await mkdir(dirname(resolve(packageRoot, asset.path)), { recursive: true });
  await writeFile(resolve(packageRoot, asset.path), optimizedSvg, 'utf8');
}

const faviconSvg = generated.find(({ path }) => path === 'brand/favicon.svg').svg;
for (const size of [192, 512]) {
  await sharp(Buffer.from(faviconSvg))
    .resize(size, size)
    .png()
    .toFile(resolve(packageRoot, `brand/app-icon-${size}.png`));
}

const manifestPath = resolve(packageRoot, 'manifest.json');
const existingManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const generatedAssetEntries = [
  ...generated.map(({ path, kind, variant, width, height }) => ({
    path,
    kind,
    variant,
    format: 'svg',
    width,
    height,
  })),
  {
    path: 'brand/social-card.png',
    source: 'brand/social-card.svg',
    kind: 'social-card',
    variant: 'light',
    format: 'png',
    width: 1200,
    height: 630,
  },
  ...[192, 512].map((size) => ({
    path: `brand/app-icon-${size}.png`,
    source: 'brand/favicon.svg',
    kind: 'app-icon',
    variant: 'crown',
    format: 'png',
    width: size,
    height: size,
  })),
];
const ownedAssetPaths = new Set(generatedAssetEntries.map(({ path }) => path));
const manifest = {
  ...existingManifest,
  name: '@moonwitness/assets',
  schemaVersion: 1,
  licenseManifest: 'licenses.json',
  assets: replaceGeneratedAssets(existingManifest.assets, generatedAssetEntries, ownedAssetPaths),
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
stdout.write(`Generated ${generated.length} MoonWitness SVG assets and manifest.\n`);
