import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Doodle,
  InkFrame,
  InkUnderline,
  LoadingSpinner,
  SpeedLines,
  SpeechBubble,
} from '../dist/components/effects.js';

test('ink effects render as decorative shared primitives', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(SpeedLines, { count: 3 }),
      React.createElement(InkUnderline),
      React.createElement(Doodle, { kind: 'star' }),
      React.createElement(SpeechBubble, null, 'Hello'),
      React.createElement(InkFrame, null, React.createElement('span', null, 'Framed'))
    )
  );

  assert.match(html, /class="mw-ui-speed-lines(?:\s|")/u);
  assert.match(html, /class="mw-ui-speed-lines-pulse"/u);
  assert.match(html, /class="mw-ui-ink-underline(?:\s|")/u);
  assert.match(html, /class="mw-ui-ink-underline-path"/u);
  assert.match(html, /pathLength="1"/u);
  assert.match(html, /class="mw-ui-doodle"/u);
  assert.match(html, /class="mw-ui-speech-bubble(?:\s|")/u);
  assert.match(html, /class="mw-ui-ink-frame"/u);
  assert.match(html, /aria-hidden="true"/u);
});

test('loading spinner is compact and decorative while button text carries the action status', () => {
  const html = renderToStaticMarkup(React.createElement(LoadingSpinner));

  assert.match(html, /class="mw-ui-loading-spinner(?:\s|")/u);
  assert.match(html, /aria-hidden="true"/u);
});

test('speed lines stop pulsing when animation is disabled', () => {
  const html = renderToStaticMarkup(React.createElement(SpeedLines, { count: 3, animate: false }));

  assert.match(html, /mw-ui-speed-lines/u);
  assert.doesNotMatch(html, /mw-ui-speed-lines-pulse/u);
});
