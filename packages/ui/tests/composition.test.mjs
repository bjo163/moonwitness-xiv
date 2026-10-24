import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from '../dist/components/empty-state.js';
import { BarChart } from '../dist/components/chart.js';
import { Field } from '../dist/components/field.js';
import { PageHeader } from '../dist/components/page-header.js';
import { Pagination } from '../dist/components/pagination.js';
import { Panel } from '../dist/components/panel.js';
import { Skeleton } from '../dist/components/skeleton.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../dist/components/table.js';
import { Toolbar } from '../dist/components/toolbar.js';

test('field connects labels and validation descriptions to the control', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Field,
      {
        label: 'Email',
        htmlFor: 'email',
        description: 'Work address',
        error: 'Invalid email',
        required: true,
      },
      React.createElement('input', { type: 'email' })
    )
  );
  assert.match(html, /<label[^>]*for="email"/);
  assert.match(html, /<input[^>]*id="email"/);
  assert.match(html, /aria-describedby="email-description email-error"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /role="alert"/);
});

test('pagination is controlled, bounded, and exposes disabled edge actions', () => {
  const html = renderToStaticMarkup(
    React.createElement(Pagination, { page: 1, pageCount: 4, onPageChange: () => undefined })
  );
  assert.match(html, /aria-label="Pagination"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /Page 1 of 4/);
});

test('labeled skeleton is a status and chart scroll regions are keyboard accessible', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Skeleton, { label: 'Loading model records' }),
      React.createElement(BarChart, { title: 'Model totals', data: [{ label: 'Users', value: 4 }] })
    )
  );

  assert.match(html, /<div[^>]*aria-label="Loading model records"[^>]*role="status"/);
  assert.match(html, /role="region"[^>]*aria-label="Model totals chart data"[^>]*tabindex="0"/);
});

test('composition parts retain landmarks and semantic table markup', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(PageHeader, { title: 'Users', description: 'Manage access' }),
      React.createElement(Toolbar, { 'aria-label': 'User actions', actions: 'Export' }),
      React.createElement(Panel, { title: 'Directory', children: 'Records' }),
      React.createElement(EmptyState, { title: 'No users', description: 'Invite a teammate' }),
      React.createElement(Skeleton, { className: 'h-4' }),
      React.createElement(Table, {
        children: React.createElement(
          React.Fragment,
          null,
          React.createElement(TableHead, {
            children: React.createElement(TableRow, {
              children: React.createElement(TableHeader, { scope: 'col', children: 'Name' }),
            }),
          }),
          React.createElement(TableBody, {
            children: React.createElement(TableRow, {
              children: React.createElement(TableCell, { children: 'Ada' }),
            }),
          })
        ),
      })
    )
  );
  assert.match(html, /<h1[^>]*>Users<\/h1>/);
  assert.match(html, /role="toolbar"/);
  assert.match(html, /<section[^>]*class="mw-ui-panel"/);
  assert.match(html, /<section[^>]*class="mw-ui-empty-state"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /<table[^>]*class="mw-ui-table"/);
  assert.match(html, /<th[^>]*scope="col"/);
});

test('table overflow wrapper becomes a labeled keyboard-focusable region on request', () => {
  const html = renderToStaticMarkup(
    React.createElement(Table, {
      scrollLabel: 'Installed add-ons table horizontal scroll',
      'aria-label': 'Installed add-ons',
      children: React.createElement(TableBody, {
        children: React.createElement(TableRow, {
          children: React.createElement(TableCell, { children: 'Base' }),
        }),
      }),
    })
  );

  assert.match(
    html,
    /<div class="mw-ui-table-wrap" data-slot="table-wrap" role="region" aria-label="Installed add-ons table horizontal scroll" tabindex="0">/u
  );
  assert.match(html, /<table[^>]*aria-label="Installed add-ons"/u);
});
