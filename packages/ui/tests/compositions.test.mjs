import assert from 'node:assert/strict';
import { createElement } from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtworkFrame } from '../dist/components/artwork-frame.js';
import { MetricTile } from '../dist/components/metric-tile.js';
import { Panel } from '../dist/components/panel.js';
import { PaperNote } from '../dist/components/paper-note.js';
import { SectionRibbon } from '../dist/components/section-ribbon.js';

test('compositions expose semantic, configurable visual treatments', () => {
  const markup = renderToStaticMarkup(
    createElement(
      'main',
      null,
      createElement(
        Panel,
        { title: 'Dashboard', surface: 'ink', frame: 'torn', density: 'compact', headingLevel: 3 },
        'Content'
      ),
      createElement(SectionRibbon, {
        title: 'Stories',
        number: '01',
        accent: 'cyan',
        surface: 'ink',
      }),
      createElement(PaperNote, { accent: 'yellow' }, 'Same moon, different people.'),
      createElement(
        ArtworkFrame,
        { shape: 'portrait', caption: 'Example artwork', 'aria-label': 'Example artwork' },
        createElement('img', { src: '/example.webp', alt: 'Illustration example' })
      ),
      createElement(MetricTile, {
        label: 'Active partners',
        value: '12',
        detail: 'Current records',
      })
    )
  );

  assert.match(markup, /data-surface="ink"/u);
  assert.match(markup, /data-frame="torn"/u);
  assert.match(markup, /data-density="compact"/u);
  assert.match(markup, /<h3/u);
  assert.match(markup, /Stories/u);
  assert.match(markup, /data-surface="ink"/u);
  assert.match(markup, /Same moon, different people\./u);
  assert.match(markup, /<figure[^>]*data-shape="portrait"/u);
  assert.match(markup, /<figcaption/u);
  assert.match(markup, /Active partners/u);
  assert.match(markup, /aria-label="Example artwork"/u);
});
